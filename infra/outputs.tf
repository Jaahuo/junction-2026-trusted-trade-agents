locals {
  hostname = var.domain != "" ? var.domain : "${replace(vultr_instance.app.main_ip, ".", "-")}.sslip.io"
}

output "public_ip" {
  value = vultr_instance.app.main_ip
}

output "hostname" {
  value = local.hostname
}

output "public_base_url" {
  value = "https://${local.hostname}"
}

output "app_dir" {
  value = local.app_dir
}

output "app_port" {
  value = local.app_port
}

output "database_url" {
  value     = "postgres://${timescale_service.db.username}:${urlencode(timescale_service.db.password)}@${timescale_service.db.hostname}:${timescale_service.db.port}/tsdb?sslmode=require"
  sensitive = true
}
