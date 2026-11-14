terraform {
  required_version = ">= 1.10"
  # The path comes from `tofu init -backend-config=path=...`, outside any worktree (docs/deploy.md).
  backend "local" {}
  required_providers {
    vultr = {
      source  = "vultr/vultr"
      version = "~> 2.0"
    }
    timescale = {
      source  = "timescale/timescale"
      version = ">= 1.0"
    }
  }
}
