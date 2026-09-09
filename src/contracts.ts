export interface ProfileMetadata {
  version: 1;
  name: string;
  defaultCwd: string | null;
  inheritEnvironment: string[];
  createdAt: string;
}

export interface Profile {
  root: string;
  metadata: ProfileMetadata;
}

export interface StoreOptions {
  profilesRoot: string;
  now: () => Date;
}

export interface LaunchRequest {
  profile: Profile;
  piArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface Lease {
  version: 1;
  id: string;
  hostname: string;
  launcherPid: number;
  childPid: number | null;
  createdAt: string;
  state: "starting" | "running" | "exited";
}

export class ProfileError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProfileError";
  }
}
