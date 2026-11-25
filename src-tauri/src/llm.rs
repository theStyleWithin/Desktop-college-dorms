//! Streaming chat completions. All remote traffic goes through reqwest with
//! rustls, i.e. TLS; keys are attached here in the backend and never reach
//! the web view.

use dorms_core::prompt::ChatMsg;
use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::sync::Notify;

pub struct GenParams {
    pub temperature: f32,
    pub top_p: f32,
    pub max_tokens: usize,
}

#[derive(Clone)]
pub enum Auth {
    Bearer,
    XApiKey,
    Header(String),
    None,
}

#[derive(Clone, Default)]
pub struct Extras {
    pub headers: Vec<(String, String)>,
    /// JSON object merged into the request body.
    pub body: Option<Value>,
}

pub enum Endpoint {
    /// Any OpenAI-compatible server: OpenAI, OpenRouter, Ollama, LM Studio,
    /// the bundled engine, or a user-defined "Other API".
    OpenAi { base: String, path: String, key: Option<String>, auth: Auth, model: String, extras: Extras },
    Anthropic { base: String, key: String, model: String, extras: Extras },
}

impl Endpoint {
    /// Standard OpenAI-style endpoint with bearer auth.
    pub fn openai(base: String, key: Option<String>, model: String) -> Endpoint {
        Endpoint::OpenAi { base, path: "/chat/completions".into(), key, auth: Auth::Bearer, model, extras: Extras::default() }
    }
}

fn merge_body(body: &mut Value, extra: &Option<Value>) {
    if let (Some(b), Some(Value::Object(e))) = (body.as_object_mut(), extra) {
        for (k, v) in e {
            b.insert(k.clone(), v.clone());
        }
    }
}

fn with_headers(mut r: reqwest::RequestBuilder, extras: &Extras) -> reqwest::RequestBuilder {
    for (n, v) in &extras.headers {
        if !n.trim().is_empty() {
            r = r.header(n.trim(), v);
        }
    }
    r
}

fn trim_err(s: &str) -> String {
    let s = s.trim();
    if s.len() > 400 { format!("{}…", &s[..400]) } else { s.to_string() }
}

/// Streams a completion, calling `on_token` for each text delta. Returns the
/// full text. If `cancel` fires the partial text so far is returned.
pub async fn stream_chat(
    http: &reqwest::Client,
    ep: &Endpoint,
    msgs: &[ChatMsg],
    p: &GenParams,
    cancel: &Notify,
    on_token: impl FnMut(&str),
) -> Result<String, String> {
    let values: Vec<Value> = msgs.iter().map(|m| json!({ "role": m.role, "content": m.content })).collect();
    stream_chat_values(http, ep, &values, p, cancel, on_token).await
}

/// One message in the Anthropic form: a picture part written for OpenAI-style servers (`image_url` with a data URL) becomes an `image` block.
pub fn anthropic_msg(m: &Value) -> Value {
    let Some(parts) = m["content"].as_array() else { return m.clone() };
    let parts: Vec<Value> = parts.iter().map(|part| {
        if part["type"] == "image_url" {
            let url = part["image_url"]["url"].as_str().unwrap_or("");
            if let Some((head, data)) = url.strip_prefix("data:").and_then(|r| r.split_once(";base64,")) {
                return json!({ "type": "image", "source": { "type": "base64", "media_type": head, "data": data } });
            }
        }
        part.clone()
    }).collect();
    json!({ "role": m["role"], "content": parts })
}

/// The same as `stream_chat`, but the messages are JSON, so a message's `content` can be a list of parts (text and `image_url` pictures).
pub async fn stream_chat_values(
    http: &reqwest::Client,
    ep: &Endpoint,
    msgs: &[Value],
    p: &GenParams,
    cancel: &Notify,
    mut on_token: impl FnMut(&str),
) -> Result<String, String> {
    let req = match ep {
        Endpoint::OpenAi { base, path, key, auth, model, extras } => {
            let path = if path.starts_with('/') { path.clone() } else { format!("/{path}") };
            let url = format!("{}{}", base.trim_end_matches('/'), path);
            let mut body = json!({
                "model": model,
                "messages": msgs,
                "stream": true,
                "temperature": p.temperature,
                "top_p": p.top_p,
                "max_tokens": p.max_tokens,
            });
            merge_body(&mut body, &extras.body);
            let mut r = with_headers(http.post(url).json(&body), extras);
            if let Some(k) = key.as_ref().filter(|k| !k.is_empty()) {
                r = match auth {
                    Auth::Bearer => r.bearer_auth(k),
                    Auth::XApiKey => r.header("x-api-key", k),
                    Auth::Header(name) if !name.trim().is_empty() => r.header(name.trim(), k),
                    _ => r,
                };
            }
            r
        }
        Endpoint::Anthropic { base, key, model, extras } => {
            let system = msgs.iter().filter(|m| m["role"] == "system").filter_map(|m| m["content"].as_str()).collect::<Vec<_>>().join("\n\n");
            let rest: Vec<Value> = msgs.iter().filter(|m| m["role"] != "system").map(anthropic_msg).collect();
            let mut body = json!({
                "model": model,
                "system": system,
                "messages": rest,
                "stream": true,
                "temperature": p.temperature,
                "max_tokens": p.max_tokens,
            });
            merge_body(&mut body, &extras.body);
            with_headers(
                http.post(format!("{}/v1/messages", base.trim_end_matches('/')))
                    .header("x-api-key", key)
                    .header("anthropic-version", "2023-06-01")
                    .json(&body),
                extras,
            )
        }
    };

    let notified = cancel.notified();
    tokio::pin!(notified);

    let resp = tokio::select! {
        _ = &mut notified => return Ok(String::new()),
        r = req.send() => r.map_err(|e| format!("Could not reach the model: {e}"))?,
    };
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if body.contains("exceeds the available context size") {
            return Err("This character's prompt doesn't fit in the model's context window. Pick a model with a larger context, or shorten the card.".into());
        }
        return Err(format!("The model server answered {status}: {}", trim_err(&body)));
    }

    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = vec![];
    let mut full = String::new();

    'outer: loop {
        tokio::select! {
            _ = &mut notified => break,
            chunk = stream.next() => {
                let Some(chunk) = chunk else { break };
                let chunk = chunk.map_err(|e| format!("Connection lost: {e}"))?;
                buf.extend_from_slice(&chunk);
                if buf.len() > 8 * 1024 * 1024 {
                    return Err("The server sent an unexpectedly large response line.".into());
                }
                while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = buf.drain(..=nl).collect();
                    let line = String::from_utf8_lossy(&line);
                    let line = line.trim();
                    let Some(data) = line.strip_prefix("data:") else { continue };
                    let data = data.trim();
                    if data == "[DONE]" {
                        break 'outer;
                    }
                    let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
                    let delta = match ep {
                        Endpoint::OpenAi { .. } => v["choices"][0]["delta"]["content"].as_str(),
                        Endpoint::Anthropic { .. } => match v["type"].as_str() {
                            Some("content_block_delta") => v["delta"]["text"].as_str(),
                            Some("error") => {
                                return Err(trim_err(&v["error"]["message"].as_str().unwrap_or("provider error").to_string()));
                            }
                            _ => None,
                        },
                    };
                    if let Some(t) = delta {
                        if !t.is_empty() {
                            full.push_str(t);
                            on_token(t);
                        }
                    }
                }
            }
        }
    }
    Ok(full)
}

/// The `GET .../models` request for an endpoint (with its key and headers).
fn models_request(http: &reqwest::Client, ep: &Endpoint) -> reqwest::RequestBuilder {
    match ep {
        Endpoint::OpenAi { base, key, auth, extras, .. } => {
            let mut r = with_headers(http.get(format!("{}/models", base.trim_end_matches('/'))), extras);
            if let Some(k) = key.as_ref().filter(|k| !k.is_empty()) {
                r = match auth {
                    Auth::Bearer => r.bearer_auth(k),
                    Auth::XApiKey => r.header("x-api-key", k),
                    Auth::Header(name) if !name.trim().is_empty() => r.header(name.trim(), k),
                    _ => r,
                };
            }
            r
        }
        Endpoint::Anthropic { base, key, extras, .. } => with_headers(
            http.get(format!("{}/v1/models", base.trim_end_matches('/')))
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01"),
            extras,
        ),
    }
}

/// Is the server behind an endpoint up? A quick `GET .../models`.
#[derive(Debug, PartialEq)]
pub enum Health {
    /// It answered normally (a server with no model list, answering 404, still counts: it is up).
    Ok,
    /// It is up but something needs attention: the key was refused, or it is limiting requests.
    Warn(String),
    /// It could not be reached, or it is failing (a 5xx).
    Down(String),
}

pub async fn probe(http: &reqwest::Client, ep: &Endpoint) -> Health {
    let resp = match models_request(http, ep).timeout(std::time::Duration::from_secs(8)).send().await {
        Ok(r) => r,
        Err(e) if e.is_timeout() => return Health::Down("The server didn't answer in time.".into()),
        Err(e) => return Health::Down(format!("Could not reach the server: {}", e.without_url())),
    };
    let code = resp.status();
    match code.as_u16() {
        200..=299 | 404 | 405 => Health::Ok,
        401 | 403 => Health::Warn("The server is up but refused the API key.".into()),
        429 => Health::Warn("The server is up but is limiting requests right now.".into()),
        500..=599 => Health::Down(format!("The server is having trouble ({code}).")),
        _ => Health::Warn(format!("The server answered {code}.")),
    }
}

/// Ask an endpoint which models it offers (`GET {base}/models`). Accepts the
/// OpenAI shape (`data[].id`), Ollama-style (`models[].name`), or a bare array.
pub async fn list_remote_models(http: &reqwest::Client, ep: &Endpoint) -> Result<Vec<String>, String> {
    let req = models_request(http, ep);
    let resp = req.timeout(std::time::Duration::from_secs(20)).send().await.map_err(|e| format!("Could not reach the server: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("The server answered {status}: {}", trim_err(&body)));
    }
    let v: Value = resp.json().await.map_err(|_| "The server's model list wasn't JSON".to_string())?;
    let items = v.get("data").or_else(|| v.get("models")).unwrap_or(&v);
    let mut out: Vec<String> = items
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| {
                    m.as_str()
                        .or_else(|| m["id"].as_str())
                        .or_else(|| m["name"].as_str())
                        .or_else(|| m["model"].as_str())
                        .map(String::from)
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out.dedup();
    Ok(out)
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_picture_is_sent_to_anthropic_as_an_image_block() {
        let m = json!({ "role": "user", "content": [ { "type": "text", "text": "what is this?" }, { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,QUJD" } } ] });
        let a = anthropic_msg(&m);
        assert_eq!(a["content"][0], json!({ "type": "text", "text": "what is this?" }));
        assert_eq!(a["content"][1], json!({ "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": "QUJD" } }));
        let plain = json!({ "role": "user", "content": "hi" });
        assert_eq!(anthropic_msg(&plain), plain, "a text message is left alone");
    }

    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// One-shot HTTP server that records the request and answers with `sse`.
    async fn serve(sse: &'static str) -> (String, tokio::sync::oneshot::Receiver<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 65536];
            let mut got = String::new();
            loop {
                let n = s.read(&mut buf).await.unwrap();
                got.push_str(&String::from_utf8_lossy(&buf[..n]));
                if let Some(i) = got.find("\r\n\r\n") {
                    let len = got.to_lowercase().split("content-length:").nth(1).and_then(|r| r.trim().split("\r\n").next().and_then(|v| v.trim().parse::<usize>().ok())).unwrap_or(0);
                    if got.len() >= i + 4 + len { break; }
                }
            }
            let _ = tx.send(got);
            let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n";
            s.write_all(head.as_bytes()).await.unwrap();
            // split mid-line to exercise buffering across chunks
            let (a, b) = sse.split_at(sse.len() / 2);
            s.write_all(a.as_bytes()).await.unwrap();
            s.flush().await.unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            s.write_all(b.as_bytes()).await.unwrap();
        });
        (format!("http://{addr}"), rx)
    }

    fn msgs() -> Vec<ChatMsg> {
        vec![
            ChatMsg { role: "system".into(), content: "Be brief.".into() },
            ChatMsg { role: "user".into(), content: "hi".into() },
        ]
    }
    fn params() -> GenParams {
        GenParams { temperature: 0.5, top_p: 0.9, max_tokens: 64 }
    }

    #[tokio::test]
    async fn anthropic_stream_is_parsed_and_request_is_shaped_correctly() {
        let sse = "event: message_start\ndata: {\"type\":\"message_start\"}\n\n\
                   event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hel\"}}\n\n\
                   event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"lo *there*\"}}\n\n\
                   event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
        let (base, req) = serve(sse).await;
        let ep = Endpoint::Anthropic { base, key: "sk-ant-test".into(), model: "claude-test".into(), extras: Extras::default() };
        let mut seen = vec![];
        let out = stream_chat(&reqwest::Client::new(), &ep, &msgs(), &params(), &Notify::new(), |t| seen.push(t.to_string())).await.unwrap();
        assert_eq!(out, "Hello *there*");
        assert_eq!(seen, vec!["Hel", "lo *there*"]);
        let raw = req.await.unwrap().to_lowercase();
        assert!(raw.starts_with("post /v1/messages"));
        assert!(raw.contains("x-api-key: sk-ant-test"));
        assert!(raw.contains("anthropic-version: 2023-06-01"));
        let body: serde_json::Value = serde_json::from_str(raw.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body["system"], "be brief.");
        assert_eq!(body["messages"].as_array().unwrap().len(), 1, "system prompt is sent separately");
        assert_eq!(body["stream"], true);
        assert!(body.get("top_p").is_none(), "newer Claude models reject temperature+top_p together");
    }

    #[tokio::test]
    async fn anthropic_error_event_is_surfaced() {
        let sse = "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n";
        let (base, _) = serve(sse).await;
        let ep = Endpoint::Anthropic { base, key: "k".into(), model: "m".into(), extras: Extras::default() };
        let err = stream_chat(&reqwest::Client::new(), &ep, &msgs(), &params(), &Notify::new(), |_| {}).await.unwrap_err();
        assert!(err.contains("Overloaded"), "{err}");
    }

    #[tokio::test]
    async fn cancelling_returns_the_partial_text() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 8192];
            let _ = s.read(&mut buf).await;
            s.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n").await.unwrap();
            s.write_all(b"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n").await.unwrap();
            tokio::time::sleep(std::time::Duration::from_secs(30)).await; // never finishes
        });
        let ep = Endpoint::openai(format!("http://{addr}/v1"), None, "m".into());
        let cancel = std::sync::Arc::new(Notify::new());
        let c2 = cancel.clone();
        let canceller = tokio::spawn(async move { tokio::time::sleep(std::time::Duration::from_millis(400)).await; c2.notify_one(); });
        let out = stream_chat(&reqwest::Client::new(), &ep, &msgs(), &params(), &cancel, |_| {}).await.unwrap();
        canceller.await.unwrap();
        assert_eq!(out, "partial");
    }

    #[tokio::test]
    async fn http_errors_are_reported_with_the_status() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 8192];
            let _ = s.read(&mut buf).await;
            let body = "{\"error\":\"bad key\"}";
            s.write_all(format!("HTTP/1.1 401 Unauthorized\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        });
        let ep = Endpoint::openai(format!("http://{addr}/v1"), Some("x".into()), "m".into());
        let err = stream_chat(&reqwest::Client::new(), &ep, &msgs(), &params(), &Notify::new(), |_| {}).await.unwrap_err();
        assert!(err.contains("401") && err.contains("bad key"), "{err}");
    }

    #[tokio::test]
    async fn custom_auth_headers_path_and_extra_body_are_applied() {
        let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n";
        let (base, req) = serve(sse).await;
        let extras = Extras {
            headers: vec![("X-Org".into(), "dorms".into())],
            body: Some(json!({ "reasoning_effort": "low", "max_tokens": 7 })),
        };
        let ep = Endpoint::OpenAi {
            base, path: "v2/respond".into(), key: Some("secret".into()), auth: Auth::Header("X-Token".into()),
            model: "m".into(), extras,
        };
        let out = stream_chat(&reqwest::Client::new(), &ep, &msgs(), &params(), &Notify::new(), |_| {}).await.unwrap();
        assert_eq!(out, "ok");
        let raw = req.await.unwrap();
        let lower = raw.to_lowercase();
        assert!(lower.starts_with("post /v2/respond"), "custom path: {}", &raw[..40]);
        assert!(lower.contains("x-token: secret"));
        assert!(!lower.contains("authorization:"), "no bearer header when another auth style is chosen");
        assert!(lower.contains("x-org: dorms"));
        let body: serde_json::Value = serde_json::from_str(raw.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body["reasoning_effort"], "low");
        assert_eq!(body["max_tokens"], 7, "extra body overrides defaults");
    }

    #[tokio::test]
    async fn model_lists_in_common_shapes_are_understood() {
        for (payload, expect) in [
            (r#"{"data":[{"id":"b"},{"id":"a"}]}"#, vec!["a", "b"]),
            (r#"{"models":[{"name":"llama3"},{"name":"qwen"}]}"#, vec!["llama3", "qwen"]),
            (r#"["x","y"]"#, vec!["x", "y"]),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move {
                let (mut s, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 8192];
                let _ = s.read(&mut buf).await;
                s.write_all(format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}", payload.len()).as_bytes()).await.unwrap();
            });
            let ep = Endpoint::openai(format!("http://{addr}/v1"), None, "m".into());
            assert_eq!(list_remote_models(&reqwest::Client::new(), &ep).await.unwrap(), expect);
        }
    }
}
