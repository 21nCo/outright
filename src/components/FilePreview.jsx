import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ArrowSquareOut, ArrowsClockwise, FileX, LinkBreak, Prohibit, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { MarkdownView } from "@/components/MarkdownView";
import { formatBytes } from "@/lib/file-tree";
import { api, query } from "@/lib/runtime-api";

const PdfPreview = lazy(() => import("@/components/PdfPreview"));

// Shows one worktree file. Each response is checked against the file it was
// asked for, so a slow answer for an earlier selection is never shown. A
// refresh keeps the shown preview until its answer arrives, and keeps it
// as it is (scroll, PDF page) when the file's version has not changed.
export function FilePreview({ project, worktree, file, refreshKey, settings, onNavigate, onFolder, onRefreshFolder, onError }) {
  const [state, setState] = useState({ status: "loading", file });
  const [mode, setMode] = useState("rendered");
  const [mediaFailed, setMediaFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const target = { projectId: project.id, path: worktree.path };
  // What the effect below may keep: the preview shown at the last render,
  // unless its image or PDF failed and needs a fresh start.
  const shownRef = useRef(null);
  shownRef.current = state.status === "ready" && state.file === file && !mediaFailed ? state : null;

  useEffect(() => {
    let current = true;
    const shown = shownRef.current;
    const background = Boolean(shown);
    if (!background) { setState({ status: "loading", file }); setMediaFailed(false); }
    api(query("/api/files/preview", { ...target, file }))
      .then((preview) => {
        if (!current) return;
        if (background && preview.version === shown.preview.version && preview.previewType === shown.preview.previewType) return;
        setMediaFailed(false);
        setState({ status: "ready", file, preview });
      })
      .catch((error) => {
        if (!current) return;
        if (error.payload?.code === "IS_DIRECTORY") { onFolder?.(file); return; }
        setState({ status: "error", file, code: error.payload?.code ?? "", message: error.message });
      });
    return () => { current = false; };
    // The target is identified by its project, worktree and file alone.
  }, [project.id, worktree.path, file, refreshKey, retry]);

  const name = file.split("/").at(-1);
  const openInEditor = () => api("/api/editor/open", { method: "POST", body: { path: worktree.path, file, editor: settings?.editor } }).catch(onError);
  const editorButton = <Button variant="outline" size="xs" onClick={openInEditor}><ArrowSquareOut />Open in {settings?.editor ?? "editor"}</Button>;
  const reload = () => setRetry((value) => value + 1);

  if (state.status === "loading" || state.file !== file) return <section className="file-preview" aria-label={`Preview of ${name}`} aria-busy="true"><div className="preview-state" role="status"><SpinnerGap className="spin" />Opening {name}…</div></section>;
  if (state.status === "error") {
    const [Icon, text, action] = {
      MISSING: [FileX, `${file} no longer exists. It may have been moved or deleted.`, <Button key="refresh" variant="outline" size="xs" onClick={() => onRefreshFolder?.(file)}><ArrowsClockwise />Refresh folder</Button>],
      OUTSIDE_WORKTREE: [LinkBreak, `${file} links outside this worktree, so it is not previewed.`, null],
      LINK_LOOP: [LinkBreak, `${file} is a link that points back to itself.`, null],
      EXCLUDED: [Prohibit, "Git metadata is not shown in Files.", null],
      UNREADABLE: [Prohibit, `${file} cannot be read with your permissions.`, null],
      PREVIEW_UNAVAILABLE: [Prohibit, "Previews are unavailable on this file system, because Outright cannot prove that an opened file is inside this worktree.", editorButton],
    }[state.code] ?? [WarningCircle, `${file} could not be previewed: ${state.message}`, <Button key="retry" variant="outline" size="xs" onClick={reload}><ArrowsClockwise />Retry</Button>];
    return <section className="file-preview" aria-label={`Preview of ${name}`}><div className="preview-state" role="alert"><Icon /><p>{text}</p>{action}</div></section>;
  }

  const { preview } = state;
  const raw = query("/api/files/raw", { ...target, file, version: preview.version });
  const imageUrl = (path) => query("/api/files/raw", { ...target, file: path });
  const details = [formatBytes(preview.size), preview.link ? `link to ${preview.link.target}` : ""].filter(Boolean).join(" · ");
  let body;
  if (preview.previewType === "markdown" && mode === "rendered") body = <MarkdownView source={preview.text} file={preview.link?.target ?? file} imageUrl={imageUrl} onNavigate={onNavigate} />;
  else if (preview.previewType === "markdown" || preview.previewType === "text") body = <pre className="file-text" tabIndex={0} aria-label={`Contents of ${name}`}>{preview.text}</pre>;
  else if (mediaFailed) body = <div className="preview-state" role="alert"><WarningCircle /><p>{name} could not be shown. It may have changed since it was opened.</p><Button variant="outline" size="xs" onClick={reload}><ArrowsClockwise />Retry</Button></div>;
  else if (preview.previewType === "image") body = <div className="image-preview"><img src={raw} alt={`Preview of ${name}`} onError={() => setMediaFailed(true)} /></div>;
  else if (preview.previewType === "pdf") body = <Suspense fallback={<div className="preview-state" role="status"><SpinnerGap className="spin" />Loading PDF viewer…</div>}><PdfPreview url={raw} name={name} /></Suspense>;
  else if (preview.previewType === "oversized") body = <div className="preview-state" role="status"><Prohibit /><p>{name} is {formatBytes(preview.size)}, over the {formatBytes(preview.limit)} preview limit for this type.</p>{editorButton}</div>;
  else body = <div className="preview-state" role="status"><Prohibit /><p>{name} has no preview. {preview.reason ?? ""}</p>{editorButton}</div>;

  return <section className="file-preview" aria-label={`Preview of ${name}`}>
    <header className="file-preview-header">
      <div><strong title={file}>{name}</strong><span>{details}</span></div>
      {preview.previewType === "markdown" && <div className="file-preview-mode" role="group" aria-label="Markdown view">
        <Button variant={mode === "rendered" ? "secondary" : "ghost"} size="xs" aria-pressed={mode === "rendered"} onClick={() => setMode("rendered")}>Preview</Button>
        <Button variant={mode === "source" ? "secondary" : "ghost"} size="xs" aria-pressed={mode === "source"} onClick={() => setMode("source")}>Source</Button>
      </div>}
      <Button variant="ghost" size="icon-xs" aria-label={`Open ${name} in ${settings?.editor ?? "editor"}`} onClick={openInEditor}><ArrowSquareOut /></Button>
    </header>
    <div className="file-preview-body">{body}</div>
  </section>;
}
