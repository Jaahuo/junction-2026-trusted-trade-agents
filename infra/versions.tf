terraform {
  required_version = ">= 1.10"
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
