// A small, invented task-manager domain used to test that the engine has no built-in business
// concepts: everything below is supplied by the "host" exactly as a real application would.

import { ActionRegistry, type ActionDefinition, type ActionHandler, type Authorizer, type EntityCandidate, type EntityProvider, type ExecutionContext } from "../src";

export const TOY_ACTIONS: ActionDefinition[] = [
  {
    id: "tasks.create", description: "Create a task", risk: "low", undoable: true,
    expressions: ["create task", "add task", "new task", "add a todo", "新建任务", "添加任务", "创建任务", "加个任务"],
    examples: ["add task \"Call the bank\" to Home", "新建任务 买牛奶 到 家务"],
    params: [
      { name: "title", type: "text", required: true, capture: "remainder", maxLength: 120, description: "Task title" },
      { name: "project", type: "entity", entityKind: "project", markers: ["to", "in", "into", "under", "到", "放到", "加到"] },
      { name: "due", type: "date", markers: ["due", "by", "截止", "截止到"] },
    ],
  },
  {
    id: "tasks.list", description: "Show tasks", risk: "none",
    expressions: ["show tasks", "list tasks", "what tasks", "显示任务", "查看任务", "列出任务", "有哪些任务"],
    fillers: ["tasks", "任务"],
    params: [
      { name: "project", type: "entity", entityKind: "project", contextKey: "project" },
      { name: "when", type: "dateRange" },
    ],
  },
  {
    id: "projects.rename", description: "Rename a project", risk: "medium", undoable: true,
    expressions: ["rename project", "rename", "改名", "重命名", "把项目改名"],
    params: [
      { name: "project", type: "entity", entityKind: "project", required: true, contextKey: "project" },
      { name: "name", type: "text", required: true, capture: "marker", markers: ["to", "as", "into", "改成", "改为", "为", "叫"] },
    ],
  },
  {
    id: "projects.delete", description: "Delete a project", risk: "high", undoable: false, typedConfirmationParam: "project",
    expressions: ["delete project", "remove project", "delete", "删除项目", "删掉项目", "移除项目", "删掉"],
    params: [{ name: "project", type: "entity", entityKind: "project", required: true, contextKey: "project" }],
    context: [{ param: "project", requirement: "reference" }],
  },
  {
    id: "ui.theme", description: "Change the color theme", risk: "none",
    expressions: ["switch to", "use theme", "change theme", "theme", "切换到", "换成", "主题"],
    params: [{
      name: "theme", type: "enum", required: true,
      options: [{ value: "dark", aliases: ["dark mode", "night", "深色", "暗色", "夜间"] }, { value: "light", aliases: ["light mode", "浅色", "亮色"] }],
    }],
  },
];

export const toyRegistry = () => new ActionRegistry("toy-tasks", "1", TOY_ACTIONS);

export interface ToyData {
  projects: Array<{ id: string; name: string; owner: string }>;
  tasks: Array<{ id: string; title: string; project: string | null; owner: string }>;
}

export function toyData(): ToyData {
  return {
    projects: [
      { id: "p1", name: "Home", owner: "alice" },
      { id: "p2", name: "Work", owner: "alice" },
      { id: "p3", name: "家务", owner: "alice" },
      { id: "p4", name: "Workout", owner: "alice" },
      { id: "p9", name: "Secret", owner: "bob" },
    ],
    tasks: [],
  };
}

/** Entities are listed per tenant: alice never sees bob's projects. */
export function toyEntities(data: ToyData): EntityProvider {
  return {
    list(kind, scope): EntityCandidate[] {
      if (kind !== "project") return [];
      return data.projects.filter((p) => p.owner === scope.tenant).map((p) => ({ id: p.id, label: p.name }));
    },
  };
}

export const toyAuthorizer: Authorizer = {
  authorize({ ctx, args }) {
    if (!ctx.principal) return { allowed: false, code: "unauthenticated", message: "Sign in first." };
    if (ctx.principal !== ctx.tenant) return { allowed: false, code: "forbidden", message: "Not your workspace." };
    if (args.project === "p9" && ctx.principal !== "bob") return { allowed: false, code: "forbidden", message: "Not your project." };
    return { allowed: true };
  },
};

export function toyHandlers(data: ToyData, calls: string[] = []): Record<string, ActionHandler> {
  let next = 1;
  return {
    "tasks.create": {
      async prepare(args) {
        return { operations: [{ op: "create", target: { kind: "task", id: "new", label: String(args.title) }, after: { project: args.project ?? null } }] };
      },
      async execute(_prepared, args, ctx) {
        calls.push("tasks.create");
        const task = { id: `t${next++}`, title: String(args.title), project: (args.project as string) ?? null, owner: ctx.tenant };
        data.tasks.push(task);
        return { summary: { code: "created", message: `Created "${task.title}".` }, undo: task.id };
      },
      async undo(id) {
        data.tasks = data.tasks.filter((t) => t.id !== id);
        return { code: "undone", message: "Removed the task." };
      },
    },
    "tasks.list": {
      async prepare(args) {
        return { operations: [{ op: "read", target: { kind: "project", id: String(args.project ?? "*"), label: "tasks" } }] };
      },
      async execute(_p, args) {
        calls.push("tasks.list");
        return { summary: { code: "listed", message: "ok" }, data: data.tasks.filter((t) => !args.project || t.project === args.project) };
      },
    },
    "projects.rename": {
      async prepare(args) {
        const project = data.projects.find((p) => p.id === args.project)!;
        if (project.name === args.name) return { operations: [] };
        return { operations: [{ op: "update", target: { kind: "project", id: project.id, label: project.name }, before: project.name, after: args.name }], payload: project.name };
      },
      async execute(prepared, args) {
        calls.push("projects.rename");
        const project = data.projects.find((p) => p.id === args.project)!;
        if (String(args.name).includes("FAIL")) throw new Error("storage failure");
        project.name = String(args.name);
        return { summary: { code: "renamed", message: "Renamed." }, undo: { id: project.id, name: prepared.payload } };
      },
      async undo(payload) {
        const { id, name } = payload as { id: string; name: string };
        data.projects.find((p) => p.id === id)!.name = name;
        return { code: "undone", message: "Renamed back." };
      },
    },
    "projects.delete": {
      async prepare(args) {
        const project = data.projects.find((p) => p.id === args.project)!;
        return { operations: [{ op: "delete", target: { kind: "project", id: project.id, label: project.name } }] };
      },
      async execute(_p, args) {
        calls.push("projects.delete");
        data.projects = data.projects.filter((p) => p.id !== args.project);
        return { summary: { code: "deleted", message: "Deleted." } };
      },
    },
    "ui.theme": {
      async prepare(args) {
        return { operations: [{ op: "set", target: { kind: "preference", id: "theme", label: "theme" }, after: args.theme }] };
      },
      async execute(_p, args) {
        calls.push("ui.theme");
        return { summary: { code: "theme", message: `Theme: ${args.theme}` } };
      },
    },
  };
}

export const aliceParse = { product: "toy-tasks", tenant: "alice", today: "2026-11-11" };
export const aliceExec = (): ExecutionContext => ({ product: "toy-tasks", tenant: "alice", principal: "alice", now: new Date("2026-11-11T12:00:00Z") });
