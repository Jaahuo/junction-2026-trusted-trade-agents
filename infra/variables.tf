variable "vultr_api_key" {
  type      = string
  sensitive = true
}

variable "ts_project_id" {
  type = string
}

variable "ts_access_key" {
  type = string
}

variable "ts_secret_key" {
  type      = string
  sensitive = true
}

variable "ssh_public_key_path" {
  type    = string
  default = "~/.ssh/id_ed25519.pub"
}

variable "ci_ssh_public_key" {
  description = "Public key of the CI deploy key, authorized for root at creation. Empty adds none."
  type        = string
  default     = ""
}

variable "admin_cidr" {
  description = "IPv4 network allowed to reach SSH, as address/size."
  type        = string
  default     = "0.0.0.0/0"
}

variable "domain" {
  description = "Hostname for TLS. Empty uses <ip>.sslip.io."
  type        = string
  default     = ""
}

variable "vultr_region" {
  type    = string
  default = "fra"
}

variable "vultr_plan" {
  type    = string
  default = "vc2-2c-4gb"
}

variable "vultr_os_id" {
  description = "Ubuntu 24.04 LTS x64."
  type        = number
  default     = 2284
}

variable "ts_region" {
  type    = string
  default = "eu-central-1"
}

variable "bun_version" {
  description = "Keep equal to mise.toml."
  type        = string
  default     = "1.4.3"
}
