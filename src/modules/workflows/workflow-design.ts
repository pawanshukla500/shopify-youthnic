/**
 * Saved design for the /workflows designer (sequential-workflow-designer JSON).
 * Stored whole in the Setting table; validated here because it comes from the browser.
 */
export const WORKFLOW_DESIGN_KEY = 'workflow_designer_definition';

const MAX_BYTES = 256_000;
const MAX_STEPS = 500;
const MAX_DEPTH = 20;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Null when `value` is a storable design, otherwise the reason it is not. */
export function workflowDesignError(value: unknown): string | null {
  if (!isObject(value) || !Array.isArray(value.sequence) || !isObject(value.properties)) {
    return 'definition needs a sequence array and a properties object';
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_BYTES) return 'definition is too large';

  const ids = new Set<string>();
  const check = (sequence: unknown[], depth: number): string | null => {
    if (depth > MAX_DEPTH) return 'decisions are nested too deeply';
    for (const step of sequence) {
      if (
        !isObject(step) ||
        typeof step.id !== 'string' ||
        !step.id ||
        typeof step.name !== 'string' ||
        typeof step.type !== 'string' ||
        !isObject(step.properties)
      ) {
        return 'every step needs an id, name, type and properties';
      }
      if (ids.has(step.id)) return `duplicate step id ${step.id}`;
      ids.add(step.id);
      if (ids.size > MAX_STEPS) return 'too many steps';

      if (step.componentType === 'switch') {
        if (!isObject(step.branches)) return `decision "${step.name}" needs branches`;
        for (const branch of Object.values(step.branches)) {
          if (!Array.isArray(branch)) return `decision "${step.name}" has an invalid branch`;
          const error = check(branch, depth + 1);
          if (error) return error;
        }
      } else if (step.componentType !== 'task') {
        return `unsupported step kind ${String(step.componentType)}`;
      }
    }
    return null;
  };
  return check(value.sequence, 0);
}
