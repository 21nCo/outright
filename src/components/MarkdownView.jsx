import { useMemo, useState } from "react";
import { MARKDOWN_NODE_BUDGET, linkTarget, parseMarkdownPreview } from "@/lib/markdown";

// Renders parsed Markdown as React elements only, so text is always escaped.
// Relative links open the file in the preview; relative images load through
// the runtime's verified image route; nothing loads from another origin.
// A document that would render more than the node budget is shown as source.
export function MarkdownView({ source, file, imageUrl, onNavigate }) {
  const { blocks, overBudget } = useMemo(() => parseMarkdownPreview(source), [source]);
  const context = { file, imageUrl, onNavigate };
  if (overBudget) {
    return <div className="markdown-over-budget">
      <p className="preview-notice" role="status">This Markdown would render more than {MARKDOWN_NODE_BUDGET.toLocaleString()} elements, so its source is shown instead.</p>
      <pre className="file-text" tabIndex={0} aria-label="Markdown source">{source}</pre>
    </div>;
  }
  return <div className="markdown-preview">{blocks.map((block, index) => <Block key={index} block={block} context={context} />)}</div>;
}

function Block({ block, context }) {
  const children = (nodes) => <Inline nodes={nodes} context={context} />;
  switch (block.type) {
    case "heading": { const Tag = `h${block.level}`; return <Tag>{children(block.children)}</Tag>; }
    case "paragraph": return <p>{children(block.children)}</p>;
    case "code": return <pre className="markdown-code" tabIndex={0} aria-label={block.language ? `${block.language} code` : "Code"}><code>{block.text}</code></pre>;
    case "quote": return <blockquote>{block.blocks.map((inner, index) => <Block key={index} block={inner} context={context} />)}</blockquote>;
    case "rule": return <hr />;
    case "list": {
      const items = block.items.map((item, index) => <li key={index} className={item.checked === null ? undefined : "markdown-task"}>
        {item.checked !== null && <input type="checkbox" checked={item.checked} disabled readOnly aria-label={item.checked ? "Done" : "Not done"} />}
        {item.blocks.map((inner, innerIndex) => <Block key={innerIndex} block={inner} context={context} />)}
      </li>);
      return block.ordered ? <ol start={block.start === 1 ? undefined : block.start}>{items}</ol> : <ul>{items}</ul>;
    }
    case "table": return <div className="markdown-table" tabIndex={0} role="region" aria-label="Table"><table>
      <thead><tr>{block.head.map((cell, index) => <th key={index} style={{ textAlign: block.align[index] ?? undefined }}>{children(cell)}</th>)}</tr></thead>
      <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{block.head.map((_, index) => <td key={index} style={{ textAlign: block.align[index] ?? undefined }}>{children(row[index] ?? [])}</td>)}</tr>)}</tbody>
    </table></div>;
    default: return null;
  }
}

function Inline({ nodes, context }) {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text": return node.value;
      case "break": return <br key={index} />;
      case "code": return <code key={index}>{node.value}</code>;
      case "strong": return <strong key={index}><Inline nodes={node.children} context={context} /></strong>;
      case "emphasis": return <em key={index}><Inline nodes={node.children} context={context} /></em>;
      case "delete": return <del key={index}><Inline nodes={node.children} context={context} /></del>;
      case "link": {
        const target = linkTarget(node.url, context.file);
        const label = <Inline nodes={node.children} context={context} />;
        if (target.kind === "external") return <a key={index} href={target.href} title={node.title || target.href} target="_blank" rel="noopener noreferrer nofollow">{label}</a>;
        if (target.kind === "file") return <button key={index} type="button" className="markdown-link" title={`Open ${target.path}`} onClick={() => context.onNavigate?.(target.path)}>{label}</button>;
        return <span key={index} className="markdown-inert-link" title={target.kind === "unsafe" ? "This link's address is not opened from a preview" : undefined}>{label}</span>;
      }
      case "image": {
        const target = linkTarget(node.url, context.file);
        if (target.kind === "file" && context.imageUrl) return <MarkdownImage key={index} src={context.imageUrl(target.path)} alt={node.alt} title={node.title} path={target.path} />;
        return <span key={index} className="markdown-image-placeholder" title="Images from other sites are not loaded in previews">[Image not loaded{node.alt ? `: ${node.alt}` : ""}]</span>;
      }
      default: return null;
    }
  });
}

// A worktree image that cannot be loaded (missing, not an image, or refused
// while the runtime is busy) says so and can be tried again.
function MarkdownImage({ src, alt, title, path }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <span className="markdown-image-failed" role="note">
      [Image could not be loaded{alt ? `: ${alt}` : ""}]
      <button type="button" className="markdown-link" aria-label={`Retry image ${alt || path}`} onClick={() => { setFailed(false); setAttempt((value) => value + 1); }}>Retry</button>
    </span>;
  }
  return <img key={attempt} src={src} alt={alt} title={title || undefined} loading="lazy" onError={() => setFailed(true)} />;
}
