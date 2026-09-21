import { useEffect, useState } from "react";
import { ArrowSquareOut, BookOpen, GitPullRequest, PuzzlePiece, SpinnerGap } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { api, query } from "@/lib/runtime-api";

export function ContextPane({ worktree, settings, onError }) {
  const [context, setContext] = useState(null);
  useEffect(() => { setContext(null); api(query("/api/context", { path: worktree.path })).then(setContext).catch(onError); }, [worktree.id, worktree.path, onError]);
  if (!context) return <div className="pane-loading"><SpinnerGap className="spin" />Reading project context…</div>;
  return <section className="context-pane-content">
    <ContextSection icon={BookOpen} title="Project instructions" count={context.instructionFiles.length}>{context.instructionFiles.length ? context.instructionFiles.map((file) => <article className="context-card" key={file.path}><header><strong>{file.name}</strong><Button variant="ghost" size="icon-xs" onClick={() => api("/api/editor/open", { method: "POST", body: { path: worktree.path, file: file.path.replace(`${worktree.path}/`, ""), editor: settings.editor } }).catch(onError)}><ArrowSquareOut /></Button></header><pre>{file.preview}</pre></article>) : <p>No AGENTS.md, CLAUDE.md, or Copilot instructions found.</p>}</ContextSection>
    <ContextSection icon={PuzzlePiece} title="Local skills" count={context.skills.length}>{context.skills.length ? context.skills.map((skill) => <div className="skill-row" key={skill.path}><PuzzlePiece /><span>{skill.name}</span><small>{skill.path.replace(worktree.path, ".")}</small></div>) : <p>No worktree-local skills found.</p>}</ContextSection>
    <ContextSection icon={GitPullRequest} title="Pull request" count={context.pullRequest ? 1 : 0}>{context.pullRequest ? <a className="pr-card" href={context.pullRequest.url} target="_blank" rel="noreferrer"><GitPullRequest /><span><strong>#{context.pullRequest.number} {context.pullRequest.title}</strong><small>{context.pullRequest.headRefName} → {context.pullRequest.baseRefName} · {context.pullRequest.state}</small></span><ArrowSquareOut /></a> : <p>No pull request is associated with this branch.</p>}</ContextSection>
  </section>;
}

function ContextSection({ icon: Icon, title, count, children }) { return <section className="context-section-block"><header><Icon /><strong>{title}</strong><span>{count}</span></header><div>{children}</div></section>; }
