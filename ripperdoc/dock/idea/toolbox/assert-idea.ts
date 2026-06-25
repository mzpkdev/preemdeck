import { IdeaError, inIdea } from "./core"

/** No-op inside a live JetBrains IDE (honors PREEMDECK_FORCE_IN_IDEA via inIdea); else throw IdeaError. */
export const assertIdea = (): void => {
  if (!inIdea()) {
    throw new IdeaError("no JetBrains IDE in the process ancestry")
  }
}
