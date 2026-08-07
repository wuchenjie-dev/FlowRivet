import { AlertTriangle, Plus, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";

import type { ProjectCatalogResult } from "../../contracts/projects.js";

interface ProjectSelectorProps {
  catalog: ProjectCatalogResult;
  canCancel: boolean;
  onDiscover: () => Promise<ProjectCatalogResult>;
  onSave: (externalIds: string[]) => Promise<void>;
  onAdd: (input: string) => Promise<ProjectCatalogResult>;
  onCancel: () => void;
}

export function ProjectSelector({
  catalog,
  canCancel,
  onDiscover,
  onSave,
  onAdd,
  onCancel,
}: ProjectSelectorProps) {
  const [query, setQuery] = useState("");
  const [manualInput, setManualInput] = useState("");
  const [selectedIds, setSelectedIds] = useState(() => new Set(
    catalog.projects.filter((project) => project.selected && project.available)
      .map((project) => project.externalId),
  ));
  const [catalogView, setCatalogView] = useState(catalog);
  const [pending, setPending] = useState<"discover" | "save" | "add">();
  const [error, setError] = useState<string>();

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return catalogView.projects;
    return catalogView.projects.filter((project) =>
      `${project.name} ${project.prettyName ?? ""} ${project.externalId}`
        .toLocaleLowerCase().includes(normalized),
    );
  }, [catalogView.projects, query]);
  const filteredAvailable = filtered.filter((project) => project.available);
  const allFilteredSelected = filteredAvailable.length > 0
    && filteredAvailable.every((project) => selectedIds.has(project.externalId));

  function toggle(externalId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(externalId)) next.delete(externalId);
      else next.add(externalId);
      return next;
    });
  }

  function toggleFiltered() {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const project of filteredAvailable) {
        if (allFilteredSelected) next.delete(project.externalId);
        else next.add(project.externalId);
      }
      return next;
    });
  }

  async function discover() {
    setPending("discover");
    setError(undefined);
    try {
      const next = await onDiscover();
      setCatalogView(next);
      setSelectedIds((current) => new Set([
        ...next.projects
          .filter((project) => project.available && project.selected)
          .map((project) => project.externalId),
        ...[...current].filter((id) =>
          next.projects.some((project) => project.externalId === id && project.available),
        ),
      ]));
    } catch {
      setError("项目发现失败，请检查连接后重试");
    } finally {
      setPending(undefined);
    }
  }

  async function addProject(event: React.FormEvent) {
    event.preventDefault();
    if (!manualInput.trim()) return;
    setPending("add");
    setError(undefined);
    try {
      const next = await onAdd(manualInput.trim());
      setCatalogView(next);
      setManualInput("");
    } catch {
      setError("无法添加该项目，请确认 ID、URL 和访问权限");
    } finally {
      setPending(undefined);
    }
  }

  async function save() {
    setPending("save");
    setError(undefined);
    try {
      await onSave([...selectedIds]);
    } catch {
      setError("项目选择保存失败，请重试");
    } finally {
      setPending(undefined);
    }
  }

  return (
    <main className="project-selector">
      <header className="selector-heading">
        <div>
          <p className="selector-kicker">{catalogView.provider.displayName} / 工作范围</p>
          <h1>选择项目</h1>
          <p>看板只读取你选择且当前有权限访问的项目。</p>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="重新发现项目"
          title="重新发现项目"
          disabled={Boolean(pending)}
          onClick={() => void discover()}
        >
          <RefreshCw size={16} className={pending === "discover" ? "is-spinning" : ""} />
        </button>
      </header>

      {catalogView.stale ? (
        <div className="stale-banner" role="status">
          <AlertTriangle size={15} />当前显示上次保存的项目，暂时无法从服务端更新。
        </div>
      ) : null}
      {error ? <div className="selector-error" role="alert">{error}</div> : null}

      <div className="selector-toolbar">
        <label className="project-search">
          <Search size={15} aria-hidden="true" />
          <span className="sr-only">搜索项目</span>
          <input
            type="search"
            aria-label="搜索项目"
            placeholder="搜索名称或项目 ID"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="select-filtered">
          <input
            type="checkbox"
            aria-label="选择当前筛选结果"
            checked={allFilteredSelected}
            disabled={filteredAvailable.length === 0}
            onChange={toggleFiltered}
          />
          当前结果
        </label>
        <span className="selector-count">已选 {selectedIds.size} / 可用 {catalogView.projects.filter((project) => project.available).length}</span>
      </div>

      <div className="project-list" role="list" aria-label="可选择项目">
        {filtered.map((project) => (
          <label className={`project-row${project.available ? "" : " is-unavailable"}`} key={`${project.providerId}:${project.externalId}`}>
            <input
              type="checkbox"
              aria-label={`选择项目：${project.name}`}
              checked={selectedIds.has(project.externalId)}
              disabled={!project.available}
              onChange={() => toggle(project.externalId)}
            />
            <span className="project-row-copy">
              <strong>{project.name}</strong>
              <small>{project.prettyName ?? `项目 ${project.externalId}`}</small>
            </span>
            <span className={`project-source project-source--${project.source}`}>
              {project.available ? (project.source === "manual" ? "手工添加" : "已发现") : "不可访问"}
            </span>
          </label>
        ))}
        {filtered.length === 0 ? <p className="project-list-empty">没有匹配的项目</p> : null}
      </div>

      <form className="manual-project" onSubmit={(event) => void addProject(event)}>
        <label htmlFor="manual-project-input">找不到项目？</label>
        <div>
          <input
            id="manual-project-input"
            aria-label="项目 ID 或 URL"
            placeholder="输入项目 ID 或完整 URL"
            value={manualInput}
            onChange={(event) => setManualInput(event.target.value)}
          />
          <button type="submit" disabled={Boolean(pending) || !manualInput.trim()}>
            <Plus size={15} />添加项目
          </button>
        </div>
      </form>

      <footer className="selector-actions">
        {canCancel ? <button className="secondary-button" type="button" onClick={onCancel}>返回看板</button> : <span />}
        <button
          className="primary-button"
          type="button"
          disabled={Boolean(pending) || selectedIds.size === 0}
          onClick={() => void save()}
        >
          {pending === "save" ? "正在保存..." : `使用 ${selectedIds.size} 个项目`}
        </button>
      </footer>
    </main>
  );
}
