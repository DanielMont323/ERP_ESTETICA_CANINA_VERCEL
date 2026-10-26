# Vercel Deployment Guide

This guide explains how to deploy the ERP system to Vercel using a monorepo architecture (separate projects for frontend and backend).

## Architecture

This project uses a **monorepo architecture** with two separate Vercel projects:
- **Backend Project**: Express.js API (root directory: `backend`)
- **Frontend Project**: React SPA (root directory: `frontend`)

This architecture is recommended by Vercel because:
- Each application has its own domain and deployment cycle
- Frontend and backend can be updated independently
- Better separation of concerns
- Easier to debug and maintain

## Prerequisites

- MongoDB Atlas account (for database)
- Git repository with the code
- Vercel account

## Step 1: Deploy Backend to Vercel

### 1.1 Create Backend Project in Vercel

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Click "Add New..." → "Project"
3. Select your Git repository
4. Configure the project:
   - **Framework Preset**: "Other"
   - **Root Directory**: `backend`
   - **Build Command**: (leave empty - Vercel will detect Express automatically)
   - **Output Directory**: (leave empty)
   - **Install Command**: `npm install`

### 1.2 Configure Environment Variables

Add the following environment variables in Vercel (Settings → Environment Variables):

| Variable | Description | Secret |
|----------|-------------|--------|
| `MONGODB_URI` | MongoDB Atlas connection string | Yes |
| `JWT_SECRET` | Secure random string for JWT signing | Yes |
| `NODE_ENV` | Environment setting | No (set to `production`) |

**Important**: 
- Add these variables for all environments: Production, Preview, and Development
- Never commit actual values to the repository
- Generate a secure JWT_SECRET using: `openssl rand -base64 32`

### 1.3 Deploy

Click "Deploy". Vercel will:
- Install dependencies
- Detect Express.js automatically
- Deploy as a Vercel Function
- Provide a URL like: `https://your-backend.vercel.app`

### 1.4 Test Backend

Once deployed, test the health endpoint:
```
https://your-backend.vercel.app/api/health
```

You should see: `{"status":"OK","timestamp":"..."}`

## Step 2: Deploy Frontend to Vercel

### 2.1 Create Frontend Project in Vercel

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Click "Add New..." → "Project"
3. Select the **same** Git repository
4. Configure the project:
   - **Framework Preset**: "Create React App"
   - **Root Directory**: `frontend`
   - **Build Command**: `npm run build`
   - **Output Directory**: `build`
   - **Install Command**: `npm install`

### 2.2 Configure Environment Variables

Add the following environment variable in Vercel:

| Variable | Description | Secret |
|----------|-------------|--------|
| `REACT_APP_API_URL` | Backend API URL | No |

**Value**: Use your backend URL from Step 1
- Production: `https://your-backend.vercel.app/api`
- Preview: `https://your-backend.vercel.app/api` (same for preview deployments)
- Development: `http://localhost:5000/api` (for local development)

### 2.3 Deploy

Click "Deploy". Vercel will:
- Install dependencies
- Build the React app
- Deploy static files
- Provide a URL like: `https://your-frontend.vercel.app`

### 2.4 Test Frontend

Once deployed:
1. Open the frontend URL
2. Try to login (you may need to register a user first)
3. Verify the app connects to the backend API

## Step 3: MongoDB Atlas Setup

### 3.1 Create MongoDB Atlas Cluster

1. Go to [MongoDB Atlas](https://www.mongodb.com/cloud/atlas)
2. Create a free cluster (M0 or M2)
3. Create a database user with username and password
4. Whitelist IP addresses: use `0.0.0.0/0` for Vercel access

### 3.2 Get Connection String

1. In MongoDB Atlas, click "Connect" → "Connect your application"
2. Copy the connection string
3. Replace `<password>` with your actual password
4. Use this as `MONGODB_URI` in Vercel environment variables

Example format:
```
mongodb+srv://username:password@cluster.mongodb.net/erp-db
```

## Project Structure in Vercel

After deployment, you will have:
- **Backend URL**: `https://your-backend.vercel.app`
- **Frontend URL**: `https://your-frontend.vercel.app`

Both projects are connected to the same Git repository. Each push will trigger deployments for both projects.

## Local Development

To run locally:

```bash
# Backend
cd backend
cp .env.example .env
# Edit .env with your local settings
npm install
npm run dev

# Frontend (in a new terminal)
cd frontend
cp .env.example .env
# Edit .env with http://localhost:5000/api
npm install
npm start
```

## Updates and CI/CD

When you push changes to the Git repository:
- Vercel automatically deploys both projects
- Each project builds independently
- Preview deployments are created for pull requests
- Production deployments happen when merging to main branch

## Troubleshooting

### Backend Issues

- **Database connection error**: Check `MONGODB_URI` is correct and IP is whitelisted (0.0.0.0/0)
- **Build fails**: Check all dependencies are in package.json
- **CORS errors**: Ensure CORS configuration allows your frontend domain
- **API returns 404**: Verify routes are correctly defined

### Frontend Issues

- **API connection error**: Verify `REACT_APP_API_URL` matches backend URL
- **Blank page**: Check build logs for errors
- **Environment variables not working**: Ensure variables are prefixed with `REACT_APP_`
- **Login fails**: Check backend is accessible and CORS is configured correctly

### Vercel-Specific Issues

- **Build timeout**: Check if dependencies are properly cached
- **Function timeout**: API calls taking too long (optimize database queries)
- **Cold starts**: Normal for serverless functions (improves with activity)

## Cost

- **Vercel Hobby Plan**: Free (for both frontend and backend)
- **MongoDB Atlas Free Tier**: $0/month (512MB storage)
- **Total cost**: $0/month for basic usage

## Notes

- The backend is deployed as a Vercel Function (serverless)
- Express.js is automatically detected by Vercel
- The backend exports the app as `module.exports = app` for Vercel compatibility
- The frontend uses React Router for client-side routing
- No custom `vercel.json` is needed for the frontend (Vercel handles React automatically)
- The backend removes the `postinstall` script that builds the frontend (not needed in monorepo)
