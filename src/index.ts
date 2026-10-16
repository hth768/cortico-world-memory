// 框架按 package.json 的 `main` 导入本文件,并读取具名导出 id/label/defaults/create
// 作为 WorldDefinition(不是默认导出)。所以这里把字段拆成具名导出。
import { MEMORY_WORLD } from './definition.ts';

export const id = MEMORY_WORLD.id;
export const label = MEMORY_WORLD.label;
export const defaults = MEMORY_WORLD.defaults;
export const create = MEMORY_WORLD.create;

export { MEMORY_WORLD } from './definition.ts';
export default MEMORY_WORLD;
export { MEMORY_DEFAULTS, MEMORY_CONFIG_GROUP, type MemoryConfig } from './config.ts';
