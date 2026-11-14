import { fail } from "./lib.ts";
import { command, ghJson } from "./workflow.ts";
import { decodeBoard } from "./workflow-decode.ts";

/** Reads, or with `update` sets, the issue's Status on the one linked project board; `add` puts it on the board. */
export async function projectStatus(
  repo: { owner: { login: string }; name: string },
  number: number,
  update?: string,
  add = false,
): Promise<string> {
  const query = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){projectsV2(first:100){nodes{id}} issue(number:$number){id projectItems(first:100){nodes{id project{id title fields(first:100){nodes{... on ProjectV2FieldCommon{id name} ... on ProjectV2SingleSelectField{options{id name}}}}} fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}`;
  const repositoryData = await ghJson(
    decodeBoard,
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${repo.owner.login}`,
    "-f",
    `repo=${repo.name}`,
    "-F",
    `number=${String(number)}`,
  );
  const projects = repositoryData.projectsV2.nodes;
  if (projects.length !== 1 || !projects[0])
    fail("Repository must be linked to exactly one project board.");
  const project = projects[0];
  const items = repositoryData.issue.projectItems.nodes.filter(
    (item) => item.project.id === project.id,
  );
  if (items.length === 0 && add) {
    const mutation = `mutation($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}`;
    await command(
      "gh",
      "api",
      "graphql",
      "-f",
      `query=${mutation}`,
      "-f",
      `project=${project.id}`,
      "-f",
      `content=${repositoryData.issue.id}`,
    );
    return projectStatus(repo, number, update);
  }
  if (items.length !== 1)
    fail("Issue is not on the linked project board; start the task or add it first.");
  const item = items[0];
  if (!item) fail("Board item missing.");
  if (update) {
    const field = item.project.fields.nodes.find((node) => node?.name === "Status");
    const choice = field?.options?.find(
      (entry) => entry.name.toLowerCase() === update.toLowerCase(),
    );
    if (!field || !choice) fail(`Project ${item.project.title} has no Status option '${update}'.`);
    const mutation = `mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}`;
    await command(
      "gh",
      "api",
      "graphql",
      "-f",
      `query=${mutation}`,
      "-f",
      `project=${item.project.id}`,
      "-f",
      `item=${item.id}`,
      "-f",
      `field=${field.id}`,
      "-f",
      `option=${choice.id}`,
    );
    return choice.name;
  }
  return item.fieldValueByName?.name ?? "unset";
}
