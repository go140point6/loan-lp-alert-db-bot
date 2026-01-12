module.exports = {
  apps: [
    {
      name: "scan-loan-lp",
      script: "jobs/scanLoanLpPositions.js",
      interpreter: "node",
      autorestart: false,
      cron_restart: "*/10 * * * *",
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
