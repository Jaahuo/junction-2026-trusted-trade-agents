provider "vultr" {
  api_key     = var.vultr_api_key
  rate_limit  = 700
  retry_limit = 3
}

provider "timescale" {
  project_id = var.ts_project_id
  access_key = var.ts_access_key
  secret_key = var.ts_secret_key
}

locals {
  app_port = 3000
  app_dir  = "/opt/trusted-trade"
}

resource "vultr_ssh_key" "deploy" {
  name    = "trusted-trade-deploy"
  ssh_key = trimspace(file(pathexpand(var.ssh_public_key_path)))
}

resource "vultr_firewall_group" "app" {
  description = "trusted-trade"
}

resource "vultr_firewall_rule" "ssh" {
  firewall_group_id = vultr_firewall_group.app.id
  protocol          = "tcp"
  ip_type           = "v4"
  subnet            = split("/", var.admin_cidr)[0]
  subnet_size       = tonumber(split("/", var.admin_cidr)[1])
  port              = "22"
}

resource "vultr_firewall_rule" "web" {
  for_each          = toset(["80", "443"])
  firewall_group_id = vultr_firewall_group.app.id
  protocol          = "tcp"
  ip_type           = "v4"
  subnet            = "0.0.0.0"
  subnet_size       = 0
  port              = each.value
}

resource "vultr_instance" "app" {
  label             = "trusted-trade"
  hostname          = "trusted-trade"
  plan              = var.vultr_plan
  region            = var.vultr_region
  os_id             = var.vultr_os_id
  backups           = "disabled"
  ssh_key_ids       = [vultr_ssh_key.deploy.id]
  firewall_group_id = vultr_firewall_group.app.id
  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    app_dir           = local.app_dir
    bun_version       = var.bun_version
    ci_ssh_public_key = trimspace(var.ci_ssh_public_key)
  })
}

resource "timescale_service" "db" {
  name        = "trusted-trade"
  milli_cpu   = 500
  memory_gb   = 2
  region_code = var.ts_region
  ha_replicas = 0

  timeouts = {
    create = "30m"
  }
}
