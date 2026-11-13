import type { ComponentType } from "react";

export interface Screen {
  readonly path: string;
  readonly title: string;
  readonly Component: ComponentType;
}

export const apiUrl = `${window.location.origin}/api`;
