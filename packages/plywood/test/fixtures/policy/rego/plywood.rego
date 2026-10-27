package plywood

import rego.v1

# Denies the preview: a change that deletes a bucket.
deny_bucket_delete contains msg if {
  some m in input.members
  some e in m.entries
  e.op == "delete"
  startswith(e.type, "aws:s3/bucket")
  msg := sprintf("deletes bucket %s", [e.urn])
}

# Holds the preview for a person: a change that replaces anything.
hold_replace contains msg if {
  some m in input.members
  some e in m.entries
  e.op == "replace"
  msg := sprintf("replaces %s", [e.urn])
}
