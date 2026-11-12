import { Component, lazy, Suspense, useEffect, useRef, useState } from "react";
import { ArrowSquareOut, ArrowsClockwise, FileX, LinkBreak, Prohibit, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { MarkdownView } from "@/components/MarkdownView";
import { formatBytes, samePreview } from "@/lib/file-tree";
import { retryingImport } from "@/lib/module-retry";
import { api, query } from "@/lib/runtime-api";

// The PDF viewer loads on first use, through retryingImport, as does the
// pdf.js library (PdfPreview.jsx). These are the only dynamic imports on
// this page's side of the preview path; tests/preview-build.test.mjs checks
// that the production build keeps each one retryable.
// The worker itself is started by PdfPreview for each document and given
// to pdf.js, so pdf.js's own import of the worker script never runs; a
// failed start is retried by the next attempt's new worker, and anything
// that worker imports starts afresh with it. A rejected lazy() keeps its
// rejection, so a failed load replaces the lazy component for the next
// attempt, which retryingImport loads afresh.
const loadPdfViewer = retryingImport(() => import("@/components/PdfPreview"), { exports: ["default"] });
function pdfViewer() {
  const Viewer = lazy(() => loadPdfViewer().catch((error) => {
    if (PdfPreview === Viewer) PdfPreview = pdfViewer();
    throw error;
  }));
  return Viewer;
}
let PdfPreview = pdfViewer();

// Keeps a preview that cannot render (for example a viewer that did not
// load) inside this pane: the tree, other panes and the conversation stay.
// A refresh (resetKey) tries again, as it does for every failed preview.
class PreviewBoundary extends Component {
  state = { error: null, resetKey: this.props.resetKey };
  static getDerivedStateFromError(error) { return { error }; }
  static getDerivedStateFromProps(props, state) { return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey }; }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="preview-state" role="alert"><WarningCircle /><p>{this.props.name} could not be shown: {this.state.error.message || "the viewer did not load"}</p>
      <Button variant="outline" size="xs" onClick={this.props.onRetry}><ArrowsClockwise />Retry</Button></div>;
  }
}

// Shows one worktree file. Each response is checked against the file it was
// asked for, so a slow answer for an earlier selection is never shown. A
// refresh keeps the shown preview until its answer arrives, and keeps it
// as it is (scroll, PDF page) only when the answer shows the same thing.
export function FilePreview({ project, worktree, file, refreshKey, settings, onNavigate, onResolved, onFolder, onRefreshFolder, onError }) {
  const [state, setState] = useState({ status: "loading", file });
  const [mode, setMode] = useState("rendered");
  const [mediaFailed, setMediaFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const target = { projectId: project.id, path: worktree.path };
  // What the effect below may keep: the preview shown at the last render,
  // unless its image or PDF failed (mediaFailed) and needs a fresh start.
  const shownRef = useRef(null);
  shownRef.current = state.status === "ready" && state.file === file && !mediaFailed ? state : null;

  useEffect(() => {
    let current = true;
    // A request for a file no longer shown is aborted.
    const controller = new AbortController();
    const shown = shownRef.current;
    const background = Boolean(shown);
    if (!background) { setState((prior) => ({ status: "loading", file, path: prior.path })); setMediaFailed(false); }
    api(query("/api/files/preview", { ...target, file }), { signal: controller.signal })
      .then((preview) => {
        if (!current) return;
        if (background && samePreview(shown.preview, preview)) return;
        if (!background && typeof preview.path === "string") onResolved?.(file, preview.path); // The file the runtime opened.
        setMediaFailed(false);
        setState({ status: "ready", file, path: typeof preview.path === "string" ? preview.path : file, preview });
      })
      .catch((error) => {
        if (!current) return;
        if (error.payload?.code === "IS_DIRECTORY") { onFolder?.(file); return; }
        setState((prior) => ({ status: "error", file, path: prior.path, code: error.payload?.code ?? "", message: error.message }));
      });
    return () => { current = false; controller.abort(); };
    // The target is identified by its project, worktree and file alone.
  }, [project.id, worktree.path, file, refreshKey, retry]);

  // Once the runtime answers, its path names the file: label, editor, link and image base, Refresh folder.
  const opened = (state.file === file && state.path) || file;
  const name = opened.split("/").at(-1);
  const openInEditor = () => api("/api/editor/open", { method: "POST", body: { path: worktree.path, file: opened, editor: settings?.editor } }).catch(onError);
  const editorButton = <Button variant="outline" size="xs" onClick={openInEditor}><ArrowSquareOut />Open in {settings?.editor ?? "editor"}</Button>;
  // Retry replaces its button, so focus moves to the preview, which stays.
  const sectionRef = useRef(null);
  const reload = () => { sectionRef.current?.focus(); setRetry((value) => value + 1); };

  if (state.status === "loading" || state.file !== file) return <section ref={sectionRef} tabIndex={-1} className="file-preview" aria-label={`Preview of ${name}`} aria-busy="true"><div className="preview-state" role="status"><SpinnerGap className="spin" />Opening {name}…</div></section>;
  if (state.status === "error") {
    const [Icon, text, action] = {
      MISSING: [FileX, `${opened} no longer exists. It may have been moved or deleted.`, <Button key="refresh" variant="outline" size="xs" onClick={() => onRefreshFolder?.(opened)}><ArrowsClockwise />Refresh folder</Button>],
      BROKEN_LINK: [LinkBreak, `${opened} is a broken link: the file it points to does not exist.`, <Button key="refresh" variant="outline" size="xs" onClick={() => onRefreshFolder?.(opened)}><ArrowsClockwise />Refresh folder</Button>],
      OUTSIDE_WORKTREE: [LinkBreak, `${file} links outside this worktree, so it is not previewed.`, null],
      PATH_OUTSIDE: [Prohibit, `${file} is not a path inside this worktree. Use a path relative to the worktree root, without "..".`, null],
      LINK_LOOP: [LinkBreak, `${file} is a link that points back to itself.`, null],
      EXCLUDED: [Prohibit, "Git metadata is not shown in Files.", null],
      UNREADABLE: [Prohibit, `${file} cannot be read with your permissions.`, null],
      PREVIEW_UNAVAILABLE: [Prohibit, "Previews are unavailable on this file system, because Outright cannot prove that an opened file is inside this worktree.", editorButton],
    }[state.code] ?? [WarningCircle, `${file} could not be previewed: ${state.message}`, <Button key="retry" variant="outline" size="xs" onClick={reload}><ArrowsClockwise />Retry</Button>];
    return <section ref={sectionRef} tabIndex={-1} className="file-preview" aria-label={`Preview of ${name}`}><div className="preview-state" role="alert"><Icon /><p>{text}</p>{action}</div></section>;
  }

  const { preview } = state;
  const raw = query("/api/files/raw", { ...target, file: opened, version: preview.version });
  // A refresh asks for images again, so one that failed, or changed in place
  // without a new version, is loaded afresh while a kept preview stays as it is.
  const imageUrl = (path, version) => query("/api/files/raw", { ...target, file: path, version, refresh: refreshKey + retry });
  const details = [formatBytes(preview.size), preview.link ? `link to ${preview.link.target}` : ""].filter(Boolean).join(" · ");
  let body;
  if (preview.previewType === "markdown" && mode === "rendered") body = <MarkdownView source={preview.text} file={preview.link?.target ?? opened} imageUrl={imageUrl} onNavigate={onNavigate} />;
  else if (preview.previewType === "markdown" || preview.previewType === "text") body = <pre className="file-text" tabIndex={0} aria-label={`Contents of ${name}`}>{preview.text}</pre>;
  else if (mediaFailed) body = <div className="preview-state" role="alert"><WarningCircle /><p>{typeof mediaFailed === "string" ? `${name} could not be read: ${mediaFailed}` : `${name} could not be shown. It may have changed since it was opened.`}</p><Button variant="outline" size="xs" onClick={reload}><ArrowsClockwise />Retry</Button></div>;
  else if (preview.previewType === "image") body = <div className="image-preview"><img src={imageUrl(opened, preview.version)} alt={`Preview of ${name}`} onError={() => setMediaFailed(true)} /></div>;
  else if (preview.previewType === "pdf") body = <Suspense fallback={<div className="preview-state" role="status"><SpinnerGap className="spin" />Loading PDF viewer…</div>}><PdfPreview url={raw} name={name} refreshKey={refreshKey} onFailed={(message) => setMediaFailed(message || true)} /></Suspense>;
  else if (preview.previewType === "oversized") body = <div className="preview-state" role="status"><Prohibit /><p>{name} is {formatBytes(preview.size)}, over the {formatBytes(preview.limit)} preview limit for this type.</p>{editorButton}</div>;
  else body = <div className="preview-state" role="status"><Prohibit /><p>{name} has no preview. {preview.reason ?? ""}</p>{editorButton}</div>;

  return <section ref={sectionRef} tabIndex={-1} className="file-preview" aria-label={`Preview of ${name}`}>
    <header className="file-preview-header">
      <div><strong title={opened}>{name}</strong><span>{details}</span></div>
      {preview.previewType === "markdown" && <div className="file-preview-mode" role="group" aria-label="Markdown view">
        <Button variant={mode === "rendered" ? "secondary" : "ghost"} size="xs" aria-pressed={mode === "rendered"} onClick={() => setMode("rendered")}>Preview</Button>
        <Button variant={mode === "source" ? "secondary" : "ghost"} size="xs" aria-pressed={mode === "source"} onClick={() => setMode("source")}>Source</Button>
      </div>}
      <Button variant="ghost" size="icon-xs" aria-label={`Open ${name} in ${settings?.editor ?? "editor"}`} onClick={openInEditor}><ArrowSquareOut /></Button>
    </header>
    <div className="file-preview-body"><PreviewBoundary key={retry} resetKey={refreshKey} name={name} onRetry={reload}>{body}</PreviewBoundary></div>
  </section>;
}
