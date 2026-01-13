module.exports = {
  apps: [
    {
      name: "scan-loan-lp",
      script: "jobs/scanLoanLpPositions.js",
      interpreter: "node",
      //node_args: "--trace-deprecation",
      autorestart: false,
      cron_restart: "*/10 * * * *",
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};