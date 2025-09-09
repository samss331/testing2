import { getGithubUser } from "../handlers/github_handlers";

export async function getGitAuthor() {
  const user = await getGithubUser();
  const author = user
    ? {
        name: `[ternary]`,
        email: user.email,
      }
    : {
        name: "[ternary]",
        email: "git@ternarystudioai.com",
      };
  return author;
}
