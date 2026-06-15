import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { useCallback } from "react";
import { type AsyncQueryState, useAsyncQuery } from "./useAsyncQuery";

export const FILE_SEARCH_MIN_QUERY = 2;
const LIMIT = 50;
const DEBOUNCE_MS = 100;

export type FileHit = {
  path: string;
  rel: string;
  name: string;
  is_dir: boolean;
};

type SearchResponse = {
  hits: FileHit[];
  truncated: boolean;
};

export function useFileSearch(
  root: string | null,
  term: string,
  enabled: boolean,
): AsyncQueryState<FileHit> {
  const run = useCallback(
    async (q: string): Promise<FileHit[]> => {
      if (!root) return [];
      const res = await invoke<SearchResponse>("fs_search", {
        root,
        query: q,
        limit: LIMIT,
        showHidden: false,
        workspace: currentWorkspaceEnv(),
      });
      return res.hits.filter((h) => !h.is_dir);
    },
    [root],
  );

  return useAsyncQuery({
    enabled: enabled && !!root,
    term,
    minLength: FILE_SEARCH_MIN_QUERY,
    debounceMs: DEBOUNCE_MS,
    run,
  });
}
