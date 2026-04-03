# Terraform Drift Reconciliation Workspace

## Supported Resource Types

The reconciliation workspace currently scans these Terraform-managed AWS resource types directly:

- `aws_instance`
- `aws_security_group`
- `aws_vpc`
- `aws_subnet`
- `aws_route_table`
- `aws_internet_gateway`
- `aws_nat_gateway`
- `aws_ec2_transit_gateway`
- `aws_network_interface`
- `aws_s3_bucket`
- `aws_lambda_function`
- `aws_db_instance`
- `aws_rds_cluster`
- `aws_ecr_repository`
- `aws_eks_cluster`
- `aws_lb`
- `aws_ecs_service`
- `aws_cloudwatch_metric_alarm`
- `aws_route53_record`
- `aws_ecs_cluster`
- `aws_ecs_cluster_capacity_providers`
- `aws_eks_node_group`
- `aws_iam_role`
- `aws_iam_role_policy_attachment`
- `aws_eip`
- `aws_db_subnet_group`
- `aws_rds_cluster_instance`
- `aws_route_table_association`
- `aws_security_group_rule`

Unsupported Terraform-managed resource types remain visible in the drift tab with status `unsupported`. They are intentionally not hidden, so operators can see where the app still requires `terraform plan` or `terraform state show`.

## What Counts As Verified

Verified findings come from direct comparisons between Terraform state and live AWS inventory for supported resource types. This includes:

- Exact or near-exact identity matches using cloud identifiers and logical names
- Missing resources where Terraform state references a resource that is no longer present in the scanned live inventory
- Unmanaged live resources where the app found a live AWS resource but no matching Terraform state entry
- Selected config-vs-live checks such as names, regions, CIDR blocks, instance classes, route-table counts, cluster versions, and similar tracked fields
- Tag drift where both Terraform state tags and live AWS tags are available in the summary model

## What Counts As Inferred

Inferred findings do not change the core drift status by themselves. They are attached as heuristic signals to help reconciliation work, especially for unmanaged live resources. Current inferred signals include:

- Likely related Terraform addresses based on matching names or tags when a live resource appears unmanaged
- Coverage notes explaining that a resource type only has partial verification instead of exhaustive provider parity

If a row includes inferred signals, the drift tab labels that separately from the verified status.

## Snapshot History And Trends

- Every manual re-scan stores a timestamped snapshot under the Electron `userData` directory in `terraform-drift-history`
- The drift tab loads cached snapshots by default and only performs a fresh live AWS scan when the operator triggers a manual re-scan
- Trend status is computed from the latest two snapshots using actionable issue counts: `drifted`, `missing_in_aws`, and `unmanaged_in_aws`
- `unsupported` items are preserved for visibility but do not imply full verification coverage
