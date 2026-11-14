import { fail } from "./lib.ts";

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null)
    fail(`Invalid GitHub response: expected object for ${key}`);
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}
function text(value: unknown): string {
  if (typeof value !== "string") fail("Invalid GitHub response: expected string");
  return value;
}
function number(value: unknown): number {
  if (typeof value !== "number") fail("Invalid GitHub response: expected number");
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") fail("Invalid GitHub response: expected boolean");
  return value;
}
function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}
function list<T>(value: unknown, decode: (entry: unknown) => T): T[] {
  if (!Array.isArray(value)) fail("Invalid GitHub response: expected array");
  return value.map((entry: unknown) => decode(entry));
}
const login = (value: unknown) => ({ login: text(field(value, "login")) });
const id = (value: unknown) => ({ id: text(field(value, "id")) });
export const decodeRepository = (value: unknown) => ({
  nameWithOwner: text(field(value, "nameWithOwner")),
  name: text(field(value, "name")),
  owner: login(field(value, "owner")),
});
export const decodeUser = login;
export const decodeIssue = (value: unknown) => ({
  state: text(field(value, "state")),
  title: text(field(value, "title")),
  url: text(field(value, "url")),
  assignees: list(field(value, "assignees"), login),
});
export const decodePrs = (value: unknown) =>
  list(value, (entry) => ({
    number: number(field(entry, "number")),
    body: nullableText(field(entry, "body")),
  }));
export const decodePull = (value: unknown) => ({
  state: text(field(value, "state")),
  body: text(field(value, "body")),
  user: login(field(value, "user")),
  head: { sha: text(field(field(value, "head"), "sha")) },
  base: {
    sha: text(field(field(value, "base"), "sha")),
    ref: text(field(field(value, "base"), "ref")),
  },
});
export const decodeDependency = (value: unknown) => ({
  merged: boolean(field(value, "merged")),
  merge_commit_sha: nullableText(field(value, "merge_commit_sha")),
  head: {
    ref: text(field(field(value, "head"), "ref")),
    sha: text(field(field(value, "head"), "sha")),
  },
  base: { ref: text(field(field(value, "base"), "ref")) },
});
export const decodeMerge = (value: unknown) => ({ merged: boolean(field(value, "merged")) });
export const decodeReviews = (value: unknown) =>
  list(value, (page) =>
    list(page, (review) => {
      const user = field(review, "user");
      return {
        user:
          user === null
            ? null
            : { login: text(field(user, "login")), type: text(field(user, "type")) },
        state: text(field(review, "state")),
        commit_id: nullableText(field(review, "commit_id")),
      };
    }),
  );
export const decodeComments = (value: unknown) =>
  list(value, (page) =>
    list(page, (comment) => ({
      user: login(field(comment, "user")),
      body: text(field(comment, "body")),
    })),
  );
export const decodeChecks = (value: unknown) => ({
  check_runs: list(field(value, "check_runs"), (check) => ({
    name: text(field(check, "name")),
    status: text(field(check, "status")),
    conclusion: nullableText(field(check, "conclusion")),
  })),
});
export function decodeBoard(value: unknown) {
  const repo = field(field(value, "data"), "repository");
  const issue = field(repo, "issue");
  const items = list(field(field(issue, "projectItems"), "nodes"), (item) => {
    const project = field(item, "project");
    const status = field(item, "fieldValueByName");
    return {
      id: text(field(item, "id")),
      project: {
        id: text(field(project, "id")),
        title: text(field(project, "title")),
        fields: {
          nodes: list(field(field(project, "fields"), "nodes"), (node) => {
            if (node === null) return null;
            const options = field(node, "options");
            return {
              id: text(field(node, "id")),
              name: text(field(node, "name")),
              options:
                options === undefined
                  ? undefined
                  : list(options, (option) => ({
                      id: text(field(option, "id")),
                      name: text(field(option, "name")),
                    })),
            };
          }),
        },
      },
      fieldValueByName: status === null ? null : { name: text(field(status, "name")) },
    };
  });
  return {
    projectsV2: { nodes: list(field(field(repo, "projectsV2"), "nodes"), id) },
    issue: { id: text(field(issue, "id")), projectItems: { nodes: items } },
  };
}
const name = (value: unknown) => text(field(value, "name"));
export const decodeBacklogIssues = (value: unknown) =>
  list(value, (entry) => ({
    number: number(field(entry, "number")),
    title: text(field(entry, "title")),
    body: text(field(entry, "body")),
    labels: list(field(entry, "labels"), name),
    assignees: list(field(entry, "assignees"), (user) => login(user).login),
    status:
      list(field(entry, "projectItems"), (item) => {
        const status = field(item, "status");
        const label = status === null || status === undefined ? null : field(status, "name");
        return typeof label === "string" && label.length > 0 ? label : null;
      })[0] ?? null,
  }));
export const decodeIssueStates = (value: unknown) =>
  list(value, (entry) => ({
    number: number(field(entry, "number")),
    state: text(field(entry, "state")),
  }));
export const decodeOpenPrs = (value: unknown) =>
  list(value, (entry) => ({
    number: number(field(entry, "number")),
    headRefName: text(field(entry, "headRefName")),
    closes: list(field(entry, "closingIssuesReferences"), (issue) =>
      number(field(issue, "number")),
    ),
  }));
