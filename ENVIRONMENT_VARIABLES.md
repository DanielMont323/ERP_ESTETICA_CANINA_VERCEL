# Environment Variables Documentation

This document lists all environment variables required for the ERP system deployment on Vercel.

## Backend Environment Variables

### Required Variables

| Variable Name | Description | Component | Secret | Environments | Example Value |
|---------------|-------------|-----------|--------|--------------|---------------|
| `MONGODB_URI` | MongoDB Atlas connection string | Backend | Yes | Production, Preview, Development | `mongodb+srv://user:pass@cluster.mongodb.net/erp-db` |
| `JWT_SECRET` | Secret key for JWT token signing | Backend | Yes | Production, Preview, Development | Generated with `openssl rand -base64 32` |
| `NODE_ENV` | Node.js environment | Backend | No | Production, Preview, Development | `production` |
| `PORT` | Server port (optional) | Backend | No | Development | `5000` |

### Variable Details

#### MONGODB_URI
- **Purpose**: Connection string to MongoDB Atlas database
- **Required**: Yes
- **Secret**: Yes - contains database credentials
- **Format**: `mongodb+srv://username:password@cluster.mongodb.net/database-name`
- **Where to get**: MongoDB Atlas → Connect → Connect your application
- **Security Notes**:
  - Never commit this value to Git
  - Use IP whitelisting (0.0.0.0/0) for Vercel access
  - Use a strong password for the database user
  - Rotate credentials periodically

#### JWT_SECRET
- **Purpose**: Secret key for signing and verifying JWT tokens
- **Required**: Yes
- **Secret**: Yes - used for authentication
- **Format**: Random string (minimum 32 characters recommended)
- **How to generate**: `openssl rand -base64 32` (Linux/Mac) or use a password generator
- **Security Notes**:
  - Never commit this value to Git
  - Use a different secret for each environment
  - Generate a new secret if it's ever compromised
  - Store securely in Vercel environment variables

#### NODE_ENV
- **Purpose**: Sets the Node.js environment
- **Required**: No (defaults to development)
- **Secret**: No
- **Values**: 
  - `production` - for production deployments
  - `development` - for local development
- **Security Notes**: This affects error reporting and logging behavior

#### PORT
- **Purpose**: Server port number
- **Required**: No (Vercel sets this automatically)
- **Secret**: No
- **Values**: Any valid port number
- **Default**: `5000` for local development
- **Security Notes**: Vercel automatically sets PORT, don't override in production

## Frontend Environment Variables

### Required Variables

| Variable Name | Description | Component | Secret | Environments | Example Value |
|---------------|-------------|-----------|--------|--------------|---------------|
| `REACT_APP_API_URL` | Backend API base URL | Frontend | No | Production, Preview, Development | `https://your-backend.vercel.app/api` |

### Variable Details

#### REACT_APP_API_URL
- **Purpose**: Base URL for backend API calls
- **Required**: Yes
- **Secret**: No - this is a public URL
- **Format**: Full URL to backend API endpoint
- **Values by environment**:
  - **Production**: `https://your-backend.vercel.app/api`
  - **Preview**: `https://your-backend.vercel.app/api` (use production backend)
  - **Development**: `http://localhost:5000/api` (for local development)
- **Security Notes**:
  - Must be prefixed with `REACT_APP_` for React to include it in the build
  - This value will be visible in the browser (not secret)
  - Ensure backend has proper CORS configuration

## Security Best Practices

### 1. Never Commit Secrets
- Never add `.env` files to Git
- Use `.env.example` files with placeholder values
- Add `.env` to `.gitignore`

### 2. Use Different Secrets per Environment
- Generate separate JWT_SECRET for production, preview, and development
- Use different MongoDB users for different environments (optional but recommended)

### 3. Rotate Credentials Regularly
- Change JWT_SECRET periodically
- Rotate database passwords
- Update environment variables in Vercel after rotation

### 4. Monitor Access
- Review Vercel deployment logs
- Monitor MongoDB Atlas for unusual activity
- Set up alerts for failed authentication attempts

### 5. Principle of Least Privilege
- Database users should have minimum required permissions
- Don't use admin credentials for application access
- Consider using read-only users for certain operations

### 6. CORS Configuration
- The backend CORS is configured to allow:
  - Localhost for development
  - All origins in production (can be restricted to specific domains)
- Consider restricting to specific domains in production for better security

## How to Configure in Vercel

### Backend Project

1. Go to Vercel Dashboard → Backend Project
2. Navigate to Settings → Environment Variables
3. Add each variable:
   - **MONGODB_URI**: Paste your MongoDB connection string
   - **JWT_SECRET**: Paste your generated secret
   - **NODE_ENV**: Set to `production`
4. Select environments: Production, Preview, Development
5. Click "Save"

### Frontend Project

1. Go to Vercel Dashboard → Frontend Project
2. Navigate to Settings → Environment Variables
3. Add variable:
   - **REACT_APP_API_URL**: Set to your backend URL
4. Select environments: Production, Preview, Development
5. Click "Save"

## Validation

After configuring environment variables:

1. **Backend**: Test health endpoint
   ```
   https://your-backend.vercel.app/api/health
   ```
   Should return: `{"status":"OK","timestamp":"..."}`

2. **Frontend**: Open frontend URL and verify:
   - Application loads without errors
   - Login page is accessible
   - Console shows no CORS errors

## Troubleshooting

### Variable Not Working
- Ensure variable name is exact (case-sensitive)
- Frontend variables must start with `REACT_APP_`
- Redeploy after adding/changing variables
- Check Vercel deployment logs

### Database Connection Failed
- Verify MONGODB_URI is correct
- Check IP whitelisting in MongoDB Atlas (0.0.0.0/0)
- Ensure database user has correct permissions
- Check MongoDB Atlas cluster status

### Authentication Errors
- Verify JWT_SECRET is set and valid
- Check that token is being sent in Authorization header
- Verify token expiration time (30 days by default)
- Check browser console for error messages
