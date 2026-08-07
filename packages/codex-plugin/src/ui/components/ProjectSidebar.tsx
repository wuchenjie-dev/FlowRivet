import { AlertTriangle, CalendarClock, Layers3, Settings2 } from "lucide-react";

import type { TaskboardSnapshot } from "../../contracts/taskboard.js";

export type BoardFilter = "all" | "due_soon" | "overdue" | string;

interface ProjectSidebarProps {
  projects: TaskboardSnapshot["projects"];
  selected: BoardFilter;
  onSelect: (filter: BoardFilter) => void;
  onManageProjects: () => void;
}

export function ProjectSidebar({ projects, selected, onSelect, onManageProjects }: ProjectSidebarProps) {
  return (
    <aside className="project-sidebar" aria-label="项目导航">
      <nav>
        <p className="nav-label">视图</p>
        <button className={selected === "all" ? "nav-item is-active" : "nav-item"} type="button" onClick={() => onSelect("all")} aria-label="筛选项目：全部待办">
          <Layers3 size={16} /><span>全部待办</span><b>{projects.reduce((sum, project) => sum + project.count, 0)}</b>
        </button>
        <button className={selected === "due_soon" ? "nav-item is-active" : "nav-item"} type="button" onClick={() => onSelect("due_soon")} aria-label="筛选视图：即将到期">
          <CalendarClock size={16} /><span>即将到期</span>
        </button>
        <button className={selected === "overdue" ? "nav-item is-active" : "nav-item"} type="button" onClick={() => onSelect("overdue")} aria-label="筛选视图：已逾期">
          <AlertTriangle size={16} /><span>已逾期</span>
        </button>
        <p className="nav-label nav-label--projects">项目</p>
        {projects.map((project) => (
          <button
            key={`${project.providerId}:${project.externalId}`}
            className={selected === project.externalId ? "nav-item is-active" : "nav-item"}
            type="button"
            onClick={() => onSelect(project.externalId)}
            aria-label={`筛选项目：${project.name}`}
          >
            <span className="project-swatch" aria-hidden="true" />
            <span>{project.name}</span>
            <b>{project.count}</b>
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        <button type="button" className="manage-projects" onClick={onManageProjects}>
          <Settings2 size={15} />管理项目
        </button>
        <div className="sidebar-footnote"><span>Demo</span>模拟数据，未写入 TAPD</div>
      </div>
    </aside>
  );
}
