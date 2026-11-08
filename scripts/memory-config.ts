import { memoryBindingConfig } from "../packages/memory/src/config.js";
export function publicMemoryBinding() { return memoryBindingConfig(process.env); }
