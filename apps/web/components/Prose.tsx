import type { ReactNode } from "react";

/**
 * Minimal, safe rendering of the Markdown subset agents actually emit:
 * paragraphs, "- " / "* " / "1. " lists, **bold**, `code`, and ``` fences.
 * Everything is built as React nodes, never injected as HTML.
 */
export function Prose({ text, className = "" }: { text: string; className?: string }) {
  return <div className={`prose ${className}`}>{renderBlocks(text)}</div>;
}

function renderBlocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.trim().startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) buf.push(lines[i++]!);
      i++;
      out.push(
        <pre className="block" key={key++}>
          {buf.join("\n")}
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.push(
        <p key={key++} style={{ margin: "0 0 6px", fontWeight: 650 }}>
          {renderInline(heading[2]!)}
        </p>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*([-*•]|\d+[.)])\s+/, ""));
        i++;
        // continuation lines (indented) belong to the previous item
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]!)) {
          items[items.length - 1] += " " + lines[i]!.trim();
          i++;
        }
      }
      out.push(
        <ul key={key++} style={{ margin: "0 0 10px", paddingLeft: 22 }}>
          {items.map((it, n) => (
            <li key={n} style={{ margin: "2px 0" }}>
              {renderInline(it)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]!) &&
      !lines[i]!.trim().startsWith("```") &&
      !/^#{1,6}\s/.test(lines[i]!)
    ) {
      para.push(lines[i]!);
      i++;
    }
    out.push(
      <p key={key++} style={{ margin: "0 0 10px" }}>
        {renderInline(para.join("\n"))}
      </p>,
    );
  }
  return out;
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) nodes.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else nodes.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
