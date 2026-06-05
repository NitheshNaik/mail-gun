Start Redis — ``` docker run -d -p 6379:6379 redis:7-alpine ```
Start the API server — ```cd backend && npm run dev```
Start the Worker — ```cd backend && npm run worker ``` (you'll see the provider stats table on startup)
Start the frontend — ```cd frontend && npm run dev```

For tomorrow's presentation — just run ```node reset-smtp.mjs``` once before you demo and all providers will show fresh quotas.


Kill the process using the port ```netstat -ano | findstr :3001```
kill that process ```taskkill /PID 12345 /F```