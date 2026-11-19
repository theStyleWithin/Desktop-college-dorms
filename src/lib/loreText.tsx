import { Fragment, type ReactNode } from "react";

/** Lore written to be read: blank lines make paragraphs, `# ` and `## ` make headings, `- ` makes a list, `**bold**` and `*italic*` work. Nothing else is interpreted. */
export function renderLore(text: string): ReactNode {
  const inline = (s: string): ReactNode[] => s.split(/(\*\*[^*]+\*\*|\*[^*\n]+\*)/g).map((p, i) =>
    p.startsWith("**") && p.endsWith("**") && p.length > 4 ? <b key={i}>{p.slice(2, -2)}</b> : p.startsWith("*") && p.endsWith("*") && p.length > 2 ? <em key={i}>{p.slice(1, -1)}</em> : <Fragment key={i}>{p}</Fragment>);
  const blocks = text.replace(/\r/g, "").trim().split(/\n\s*\n/).filter((b) => b.trim());
  return blocks.map((b, i) => {
    const lines = b.split("\n");
    if (/^#{1,2}\s/.test(lines[0])) {
      const h2 = lines[0].startsWith("##");
      const head = lines[0].replace(/^#{1,2}\s+/, "");
      const rest = lines.slice(1).join("\n").trim();
      return <Fragment key={i}>{h2 ? <h4>{inline(head)}</h4> : <h3>{inline(head)}</h3>}{rest ? <p>{inline(rest)}</p> : null}</Fragment>;
    }
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) return <ul key={i}>{lines.map((l, k) => <li key={k}>{inline(l.replace(/^\s*[-*]\s+/, ""))}</li>)}</ul>;
    return <p key={i}>{lines.map((l, k) => <Fragment key={k}>{k ? <br /> : null}{inline(l)}</Fragment>)}</p>;
  });
}
