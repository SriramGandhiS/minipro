@echo off
echo Preparing to push changes to GitHub for automatic setup...
cd /d "%~dp0"

echo -----------------------------------
echo 1. Adding files to git...
git add .

echo -----------------------------------
echo 2. Committing changes...
git commit -m "Auto deploy update before project submission"

echo -----------------------------------
echo 3. Pushing to GitHub...
git push

echo -----------------------------------
echo Done! If successful, Render will now automatically pull the latest changes and deploy.
pause
