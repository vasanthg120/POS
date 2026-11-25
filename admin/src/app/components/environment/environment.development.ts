export enum Environment {
  production = 'false',
  // 3001, not 3000: another local project on the dev machine also listens on
  // 3000, and whichever starts first takes the port. Backend/.env PORT=3001.
  API_URL    = 'http://localhost:3001', // API URL
  appDomain  = 'localhost:4200', // App Domain
  payDomain  = 'localhost:4200', // Payment Domain
}
