Start Redis — ``` docker run -d -p 6379:6379 redis:7-alpine ```
Start the API server — ```npm run dev```
Start the Worker — ```npm run worker ```
Start the frontend — ```npm run dev```

Fresh quota in db - ```node reset-smtp.mjs``` 

identify the port ```netstat -ano | findstr :3001```
kill that process ```taskkill /PID 12345 /F``` (replace 12345)