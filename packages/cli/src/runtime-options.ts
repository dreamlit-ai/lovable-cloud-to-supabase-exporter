import { toBooleanFlag, trimOrNull } from "./inputs.js";
import {
  DEFAULT_CONTAINER_CONTEXT,
  DEFAULT_CONTAINER_DOCKERFILE,
  DEFAULT_DOCKER_IMAGE,
  getStringFlag,
  LOCAL_DOCKER_IMAGE,
  type ParsedArgs,
} from "./utils.js";

export type DockerRuntimeOptions = {
  dockerImage: string;
  containerContext: string;
  dockerfile: string;
  skipBuild: boolean;
};

export const dockerRuntimeOptionsFromFlags = (flags: ParsedArgs["flags"]): DockerRuntimeOptions => {
  const dockerImage = trimOrNull(getStringFlag(flags, "docker-image"));
  const containerContext = trimOrNull(getStringFlag(flags, "container-context"));
  const dockerfile = trimOrNull(getStringFlag(flags, "dockerfile"));
  const usesLocalRuntime =
    toBooleanFlag(flags["build-local-runtime"]) || Boolean(containerContext) || Boolean(dockerfile);

  return {
    dockerImage: dockerImage ?? (usesLocalRuntime ? LOCAL_DOCKER_IMAGE : DEFAULT_DOCKER_IMAGE),
    containerContext: containerContext ?? DEFAULT_CONTAINER_CONTEXT,
    dockerfile: dockerfile ?? DEFAULT_CONTAINER_DOCKERFILE,
    skipBuild: toBooleanFlag(flags["skip-build"]) || !usesLocalRuntime,
  };
};
