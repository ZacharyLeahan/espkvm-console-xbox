// SPDX-FileCopyrightText: 2026 ESP-KVM contributors
// SPDX-License-Identifier: Apache-2.0
export type SettingValue = number | string | boolean;
export type EditorState = {
  pending: number;
  drafts: Record<string, { text: string; revision: number }>;
};

/** Keep full-device replies in write order; an old save cannot erase new typing. */
export function createSettingsEditor<T>(
  state: EditorState,
  save: (key: string, value: SettingValue) => Promise<T>,
  accepted: (values: T) => void,
  failed: (error: unknown) => void,
) {
  let revision = 0;
  let tail: Promise<unknown> = Promise.resolve();
  function edit(key: string, text: string) {
    state.drafts[key] = { text, revision: ++revision };
  }
  function write(key: string, value: SettingValue, commitDraft = false): Promise<boolean> {
    const submitted = commitDraft ? state.drafts[key]?.revision : undefined;
    state.pending++;
    const result = tail.then(async () => {
      try {
        accepted(await save(key, value));
        if (submitted !== undefined && state.drafts[key]?.revision === submitted) {
          delete state.drafts[key];
        }
        return true;
      } catch (error) {
        failed(error);
        return false;
      } finally {
        state.pending--;
      }
    });
    tail = result;
    return result;
  }
  return {
    edit,
    write,
    flush: () => tail,
    shown: (key: string, saved: string) => state.drafts[key]?.text ?? saved,
    commit: (key: string, value: SettingValue) => write(key, value, true),
  };
}

/** Stable keys also distinguish sections whose human-readable titles match. */
export function groupSettings<T extends { section: string; group?: string }>(
  rows: T[], search: boolean, title: (section: string) => string,
): { key: string; name: string; rows: T[] }[] {
  const groups = new Map<string, { key: string; name: string; rows: T[] }>();
  for (const row of rows) {
    const key = search ? `section:${row.section}` : `group:${row.group ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, name: search ? title(row.section) : row.group ?? '', rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()];
}
