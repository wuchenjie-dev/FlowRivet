import { useMemo, useState } from "react";
import type { GitLabProject } from "../../contracts/gitlab.js";

export function RepositoryPicker(props: {
  projects: GitLabProject[];
  pending: boolean;
  error?: string;
  onBind: (project: GitLabProject, paths: { localPath?: string; parentDirectory?: string }) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<GitLabProject>();
  const [mode, setMode] = useState<"existing" | "clone">("existing");
  const [path, setPath] = useState("");
  const filtered = useMemo(() => props.projects.filter((project) =>
    project.pathWithNamespace.toLowerCase().includes(query.toLowerCase())), [props.projects, query]);
  return (
    <section className="repository-picker" aria-labelledby="repository-picker-heading">
      <h3 id="repository-picker-heading">选择研发仓库</h3>
      <input aria-label="搜索 GitLab 项目" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目" />
      <div className="repository-list" role="listbox" aria-label="GitLab 项目">
        {filtered.map((project) => <button key={project.projectId} type="button" role="option" aria-selected={selected?.projectId === project.projectId} onClick={() => setSelected(project)}>{project.pathWithNamespace}</button>)}
      </div>
      <div className="repository-modes"><button type="button" aria-pressed={mode === "existing"} onClick={() => setMode("existing")}>复用本地仓库</button><button type="button" aria-pressed={mode === "clone"} onClick={() => setMode("clone")}>克隆到父目录</button></div>
      <label>{mode === "existing" ? "本地仓库绝对路径" : "父目录绝对路径"}<input value={path} onChange={(event) => setPath(event.target.value)} /></label>
      {props.error ? <p role="alert">{props.error}</p> : null}
      <div className="repository-actions"><button type="button" onClick={props.onCancel}>取消</button><button type="button" disabled={!selected || !path || props.pending} onClick={() => selected && props.onBind(selected, mode === "existing" ? { localPath: path } : { parentDirectory: path })}>{props.pending ? "正在准备..." : "确认关联"}</button></div>
    </section>
  );
}
