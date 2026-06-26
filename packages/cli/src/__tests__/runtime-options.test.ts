import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dockerRuntimeOptionsFromFlags } from "../runtime-options.js";
import { DEFAULT_DOCKER_IMAGE, LOCAL_DOCKER_IMAGE, RUNTIME_IMAGE_REPOSITORY } from "../utils.js";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("dockerRuntimeOptionsFromFlags", () => {
  it("defaults installed CLI runs to the versioned runtime image without building", () => {
    expect(DEFAULT_DOCKER_IMAGE).toBe(`${RUNTIME_IMAGE_REPOSITORY}:${packageJson.version}`);

    const options = dockerRuntimeOptionsFromFlags({});

    expect(options.dockerImage).toBe(DEFAULT_DOCKER_IMAGE);
    expect(options.skipBuild).toBe(true);
  });

  it("builds the local runtime only when explicitly requested", () => {
    const options = dockerRuntimeOptionsFromFlags({ "build-local-runtime": true });

    expect(options.dockerImage).toBe(LOCAL_DOCKER_IMAGE);
    expect(options.skipBuild).toBe(false);
  });

  it("treats local runtime paths as an explicit build request", () => {
    const options = dockerRuntimeOptionsFromFlags({
      "container-context": "/repo",
      dockerfile: "/repo/packages/container-runtime/Dockerfile",
    });

    expect(options.dockerImage).toBe(LOCAL_DOCKER_IMAGE);
    expect(options.containerContext).toBe("/repo");
    expect(options.dockerfile).toBe("/repo/packages/container-runtime/Dockerfile");
    expect(options.skipBuild).toBe(false);
  });

  it("allows custom released images without building", () => {
    const options = dockerRuntimeOptionsFromFlags({
      "docker-image": "registry.example.com/exporter-runtime:1.2.3",
    });

    expect(options.dockerImage).toBe("registry.example.com/exporter-runtime:1.2.3");
    expect(options.skipBuild).toBe(true);
  });

  it("lets skip-build reuse a local runtime image without rebuilding it", () => {
    const options = dockerRuntimeOptionsFromFlags({
      "build-local-runtime": true,
      "skip-build": true,
    });

    expect(options.dockerImage).toBe(LOCAL_DOCKER_IMAGE);
    expect(options.skipBuild).toBe(true);
  });
});
