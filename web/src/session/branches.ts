import { BaseSession } from "./base";

// Wrangler needs distinct exported classes for each container/DO binding
// These exist purely to set the branch — all logic lives in BaseSession

export class GmodPublic extends BaseSession {
  protected override branch = "public";
}

export class GmodSixtyFour extends BaseSession {
  protected override branch = "sixty-four";
}

export class GmodPrerelease extends BaseSession {
  protected override branch = "prerelease";
}

export class GmodDev extends BaseSession {
  protected override branch = "dev";
}
