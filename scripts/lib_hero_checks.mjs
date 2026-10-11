// Test helper for synthetic pages that call the pure lint (infographic.mjs lintInfographicSpec) directly with a hero_stat.
// The hero value gate is always on and the lint blocks a hero_stat the runtime has not re-checked, so these pages
// hand it a re-check result that refused nothing: { any module id: [] }. Real pages get theirs from newsroom.ts.
export const CLEAN_HERO_CHECKS = new Proxy({}, { get: (_target, key) => (typeof key === 'string' ? [] : undefined) });
