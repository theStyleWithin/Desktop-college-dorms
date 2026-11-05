# Security model

Desktop College Dorms handles two kinds of untrusted input: **character cards** downloaded from elsewhere, and the
**network** when you use a cloud or custom API. This is what the app does about each, and what it can't.

## Character cards are untrusted by default

A card is just data, but its text ends up in the prompt sent to a language model, so a hostile card could try to hijack the
conversation ("ignore all previous instructions…").

- The app's own instructions are always the system prompt. Text supplied by cards is introduced as story material.
- A card's **system prompt** and **post-history instructions** are the powerful fields. For an **imported** card they are
  included only as clearly labelled *lower-priority notes*; they cannot replace the app's instructions or ride on the final
  user turn. Importing such a card shows a warning.
- You can **trust** a card (Edit → Advanced), which restores full compatibility, including `{{original}}`. Cards you create yourself
  are trusted. You can also turn card prompts off entirely (Settings → Chat).
- This reduces the risk; it can't make a language model immune to cleverly worded text. Treat cards like downloaded files.

What a hostile card **cannot** do, whatever it says: the app gives the model no tools, no file access and no network access.
A model only produces text in the chat.

## The web view is locked down

- Strict Content-Security-Policy; the UI never renders HTML from cards or models (messages are rendered as text).
- The web view can read **avatar media only**. The database and the fallback key file are outside its file scope.
- File picking and saving go through the OS dialogs; exports can only write where you chose.
- Model file names are validated (no path traversal); downloads must be `https://`, and a redirect from https to http is refused.

## Network and keys

- Remote traffic goes through the Rust backend with TLS (rustls). API keys are attached there and never reach the web view.
- Keys are stored in the OS keychain; if none is available they go in a file readable only by you (mode 0600 on Linux/macOS).
  On Windows without a keychain that fallback file is not access-controlled, so prefer the keychain.
- The built-in engine listens only on `127.0.0.1` on a random port.
- Custom "extra headers" are saved in plain settings, not the keychain. Put secrets in the key field instead.
- Plain `http://` is allowed for servers on your own network (Ollama, LM Studio); the app warns for any other plain-http address.

## Parsing limits

Card files over 64 MB are refused, compressed PNG text chunks are capped at 32 MB when inflated, and streamed responses are
size-limited, so crafted files can't exhaust memory. Lorebook regexes use a linear-time engine (no catastrophic backtracking).

## Reporting a problem

Open a private security advisory on the GitHub repository, or an issue if it is not sensitive.
