# How to Host your Push Notification Server for Free

I have created a standalone Node.js server specifically for sending your background Push Notifications. It is located in the folder: `C:\Users\Hassan\Desktop\Atrader Super Admin\render-notifications`.

Follow these steps to host it for free on **Render.com**.

---

### Step 1: Upload the Code to GitHub
Render pulls your code directly from GitHub.
1. Log into your GitHub account and create a **New Repository** (call it `atrader-notifications`).
2. Open a terminal and navigate to the `render-notifications` folder on your computer:
   ```bash
   cd "C:\Users\Hassan\Desktop\Atrader Super Admin\render-notifications"
   ```
3. Run these commands to push the code to your new GitHub repository:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/atrader-notifications.git
   git push -u origin main
   ```

---

### Step 2: Get your Firebase Service Account Key
Because this server won't be running inside Google Cloud, it needs a "key" to prove to Firebase that it's allowed to read your database.
1. Go to your **[Firebase Console](https://console.firebase.google.com/)**.
2. Click the **Gear Icon (⚙️)** next to "Project Overview" and select **Project settings**.
3. Go to the **Service accounts** tab at the top.
4. Click the blue **Generate new private key** button. 
5. This will download a `.json` file to your computer. Open this file in a text editor (like Notepad or VS Code), select all the text, and copy it.

---

### Step 3: Deploy to Render.com
1. Go to **[Render.com](https://render.com/)** and sign up or log in.
2. Click **New +** in the top right corner and select **Web Service**.
3. Connect your GitHub account and select the `atrader-notifications` repository you created in Step 1.
4. Fill out the deployment details:
   * **Name**: `atrader-notifications`
   * **Environment**: `Node`
   * **Build Command**: `npm install`
   * **Start Command**: `npm start`
   * **Instance Type**: Select the **Free** tier option.

### Step 4: Add your Environment Variable
Before clicking "Create Web Service", scroll down and click on **Advanced**.
1. Click **Add Environment Variable**.
2. For the **Key**, type exactly: `FIREBASE_SERVICE_ACCOUNT`
3. For the **Value**, paste the **entire contents** of the JSON file you downloaded from Firebase in Step 2.
4. Scroll down and click **Create Web Service**.

---

### You're Done! 🎉
Render will now build your server and launch it. It will securely connect to Firebase using your key. Whenever a new message appears in the database, the server will instantly notify the assigned agent's phone via Expo Push!
