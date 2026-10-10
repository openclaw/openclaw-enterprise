#!/usr/bin/env node
import {
  loadGitHubAppObserverInput,
  mintGitHubAppObserverToken,
} from "../../tests/helpers/github-app-observer.mjs";

const [, , inputDirectory, repository] = process.argv;
if (!inputDirectory || !repository) {
  throw new Error("usage: github-app-observer-credential-helper <input-directory> <repository>");
}

const input = await loadGitHubAppObserverInput(inputDirectory, repository);
const { token } = await mintGitHubAppObserverToken(input, {
  githubApiOrigin: process.env.OCC_TEST_QA_GITHUB_API_ORIGIN,
});
process.stdout.write(`username=x-access-token\npassword=${token}\n`);
