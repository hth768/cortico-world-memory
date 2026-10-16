// 运行期真实依赖 + 框架 `cortico/*` 类型都从这里取得,使本扩展可独立类型检查,
// 不拖入 Cortico 整个源码树(否则会因 lib 差异在框架内部文件上报错)。
// 形状按 Cortico 实际契约手描(与 templates/extension/world 对照)。运行期这些
// `import type` 会被完全擦除,框架用自己的模块钩子解析 `cortico/*`。
declare module 'cortico/core/types.ts' {
  export type ToolTag = 'read' | 'write' | 'speak' | 'act' | 'flow' | 'snapshot';
  export type EventOrigin = 'external' | 'internal';

  export interface Logger {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    [k: string]: unknown;
  }

  export interface ToolOutcome {
    text: string;
    blobs?: unknown[];
    failed?: boolean;
  }
  export interface ToolDef {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    tags: readonly ToolTag[];
    barrierAfter?: boolean;
    endsTurn?: boolean;
    handler: (args: Record<string, unknown>, ctx: unknown) => Promise<string | ToolOutcome>;
  }

  export interface PromptDocDecl {
    key: string;
    title: string;
    description: string;
    path: string;
    role: string;
    vars?: { name: string; description?: string }[];
  }
  export interface WorldConsoleDecl {
    config?: ConfigGroup[];
    promptDocs?: PromptDocDecl[];
    [k: string]: unknown;
  }
  export interface ConfigGroup {
    id: string;
    owner: string;
    schema: Record<string, unknown>;
  }

  export interface WorldSection {
    enabled: boolean;
    [k: string]: unknown;
  }

  export interface WorldHost {
    pushEvent: (e: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<unknown>;
    log: Logger;
    deploymentDir?: string;
    [k: string]: unknown;
  }

  export interface World {
    id: string;
    envPromptVars(): Record<string, string> | null;
    tools(): ToolDef[];
    console?(): WorldConsoleDecl;
    start(host: WorldHost): Promise<void>;
    stop(): void | Promise<void>;
  }
}

declare module 'cortico/world.ts' {
  import type { World, WorldSection } from 'cortico/core/types.ts';
  export interface WorldContext<S extends WorldSection = WorldSection> {
    cfg: S;
    timezone: string;
    language?: string;
    /** 部署的数据目录(整片 gitignored)。持久化数据写这里。 */
    dataDir?: string;
    [k: string]: unknown;
  }
  export interface WorldDefinition<S extends WorldSection = WorldSection> {
    id: string;
    label: string;
    defaults(): S;
    preflight?(ctx: WorldContext<S>): void;
    create(ctx: WorldContext<S>): World;
  }
}
