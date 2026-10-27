// plywood#13's fixture pack: one mandatory rule, which denies at chant's
// gate, and one advisory rule, which is a note line.
import { PolicyPack } from "@pulumi/policy";

new PolicyPack("aws-guard", {
  policies: [
    {
      name: "no-public-bucket",
      description: "A bucket is never public-read.",
      enforcementLevel: "mandatory",
      validateResource: (args, reportViolation) => {
        if (args.type === "aws:s3/bucket:Bucket" && args.props.acl === "public-read") reportViolation("the bucket is public-read");
      },
    },
    {
      name: "tagged",
      description: "Every bucket carries an owner tag.",
      enforcementLevel: "advisory",
      validateResource: (args, reportViolation) => {
        if (args.type === "aws:s3/bucket:Bucket" && !args.props.tags?.owner) reportViolation("the bucket has no owner tag");
      },
    },
  ],
});
