// 1. SETUP OUR DATA
let isOffline = false;

// Array to hold the user's saved plans
let savedPlans = [
    { id: 1, title: "Previous Failed Session", status: "Failed Sync" }
];

// Array holding all the available activities
let activities = [
    { title: "Paper Bridge Challenge", level: "Beginner", duration: "45 min" },
    { title: "Vinegar & Baking Soda", level: "Beginner", duration: "30 min" },
    { title: "Seed Germination Study", level: "Intermediate", duration: "60 min" },
    { title: "Pendulum Patterns", level: "Intermediate", duration: "45 min" },
    { title: "Advanced Robotics", level: "Advance", duration: "90 min" }
];

// 2. NETWORK CONNECTION LOGIC
function updateNetworkUI(offlineState) {
    isOffline = offlineState;
    let banner = document.getElementById('offline-banner');
    let statusText = document.getElementById('network-status-text');
    
    if (isOffline === true) {
        banner.classList.add('is-offline');
        banner.innerHTML = "<strong>Offline</strong><br><small>Data will sync when connected.</small>";
        statusText.innerText = "Offline";
    } else {
        banner.classList.remove('is-offline');
        banner.innerHTML = "<strong>Online</strong><br><small>Tap here to test offline mode.</small>";
        statusText.innerText = "Online";
        
        // If we just came back online, sync the plans
        syncPendingPlans(); 
    }
}

// Listen for actual PC Wi-Fi turning off and on
window.addEventListener('offline', function() {
    updateNetworkUI(true);
});

window.addEventListener('online', function() {
    updateNetworkUI(false);
});

// Run this as soon as the page loads to check current Wi-Fi status
window.addEventListener('DOMContentLoaded', function() {
    if (navigator.onLine === false) {
        updateNetworkUI(true);
    }
});

// Allow the user to manually click the banner to test
function toggleOfflineMode() {
    if (isOffline === true) {
        updateNetworkUI(false);
    } else {
        updateNetworkUI(true);
    }
}

// 3. SCREEN NAVIGATION
function showScreen(screenId) {
    // First, hide all screens
    let allScreens = document.querySelectorAll('.screen');
    for (let i = 0; i < allScreens.length; i++) {
        allScreens[i].classList.remove('active-screen');
    }
    
    // Then, show the one we clicked on
    document.getElementById(screenId).classList.add('active-screen');
    
    // Refresh specific screens when we open them
    if (screenId === 'screen-activities') {
        filterActivities('All');
    }
    if (screenId === 'screen-saved') {
        renderSavedPlans();
    }
}

// 4. FILTERING ACTIVITIES
function filterActivities(level) {
    let listElement = document.getElementById('activity-list');
    listElement.innerHTML = ''; // Clear the list first
    
    // Highlight the button we clicked
    let buttons = document.querySelectorAll('.filter-btn');
    for (let i = 0; i < buttons.length; i++) {
        if (buttons[i].innerText === level) {
            buttons[i].classList.add('active');
        } else {
            buttons[i].classList.remove('active');
        }
    }

    // Build the list of activities
    for (let i = 0; i < activities.length; i++) {
        let currentActivity = activities[i];
        
        // If the level matches (or we want 'All'), show the activity
        if (level === 'All' || currentActivity.level === level) {
            listElement.innerHTML += `
                <div class="card">
                    <strong>${currentActivity.title}</strong><br>
                    <small>${currentActivity.level} · ${currentActivity.duration}</small><br>
                    <button class="btn btn-small" onclick="alert('Saved for offline use!')">Save Offline</button>
                </div>
            `;
        }
    }
}

// 5. SAVING A PLAN
function savePlan() {
    let titleInput = document.getElementById('plan-title').value;
    
    // If they left it blank, give it a default name
    if (titleInput === "") {
        titleInput = "Untitled Plan";
    }

    // Determine if it should be synced or pending
    let newStatus;
    if (isOffline === true) {
        newStatus = "Pending Sync";
    } else {
        newStatus = "Synced";
    }
    
    // Create the plan object and add it to our array
    let newPlan = {
        id: Date.now(),
        title: titleInput,
        status: newStatus
    };
    savedPlans.push(newPlan);
    
    // Show success message
    let msg = document.getElementById('save-status-msg');
    msg.style.display = 'block';
    
    if (isOffline === true) {
        msg.innerText = "Saved locally. Will sync when online.";
    } else {
        msg.innerText = "Plan saved and synced!";
    }
    
    // Wait 1.5 seconds, then clear form and go to saved plans screen
    setTimeout(function() {
        msg.style.display = 'none';
        
        // Clear all text inputs
        let inputs = document.querySelectorAll('#screen-create-plan input');
        for (let i = 0; i < inputs.length; i++) {
            inputs[i].value = '';
        }
        
        showScreen('screen-saved');
    }, 1500);
}

// 6. SHOWING SAVED PLANS & SYNCING
function renderSavedPlans() {
    let listElement = document.getElementById('saved-plans-list');
    listElement.innerHTML = '';
    
    if (savedPlans.length === 0) {
        listElement.innerHTML = '<p style="text-align:center; color:#666;">No plans created yet.</p>';
        return; // Stop the function here
    }

    // Loop through all saved plans and display them
    for (let i = 0; i < savedPlans.length; i++) {
        let plan = savedPlans[i];
        
        // Pick the right color class based on the status
        let badgeClass = 'status-pending';
        if (plan.status === 'Synced') {
            badgeClass = 'status-synced';
        } else if (plan.status === 'Failed Sync') {
            badgeClass = 'status-failed';
        }
        
        // Add special buttons if there is a conflict
        let extraHTML = '';
        if (plan.status === 'Failed Sync') {
            extraHTML = `
                <div style="margin-top:10px;">
                    <small style="color:red;">Conflict: Server has a newer version.</small><br>
                    <button class="btn btn-small" onclick="resolveConflict(${plan.id}, 'server')">Use Server</button>
                    <button class="btn btn-small" onclick="resolveConflict(${plan.id}, 'local')">Keep Local</button>
                </div>
            `;
        }

        // Add the plan to the screen
        listElement.innerHTML += `
            <div class="card">
                <strong>${plan.title}</strong><br>
                <span class="status-badge ${badgeClass}">${plan.status}</span>
                ${extraHTML}
            </div>
        `;
    }
}

// Handle what happens when a user clicks a conflict button
function resolveConflict(planId, choice) {
    // Find the right plan in our array
    for (let i = 0; i < savedPlans.length; i++) {
        if (savedPlans[i].id === planId) {
            
            savedPlans[i].status = 'Synced'; // Update status
            
            // Rename it so we know which one they picked
            if (choice === 'server') {
                savedPlans[i].title = savedPlans[i].title + " (Server Version)";
            } else {
                savedPlans[i].title = savedPlans[i].title + " (Local Version)";
            }
            
            // Redraw the screen and show an alert
            renderSavedPlans();
            alert("Conflict resolved using " + choice + " version.");
            break; // Stop looking through the loop
        }
    }
}

// Automatically sync pending plans when the internet comes back
function syncPendingPlans() {
    let syncedCount = 0;
    
    for (let i = 0; i < savedPlans.length; i++) {
        if (savedPlans[i].status === 'Pending Sync') {
            savedPlans[i].status = 'Synced';
            syncedCount = syncedCount + 1;
        }
    }
    
    // If we actually synced something, update the screen and tell the user
    if (syncedCount > 0) {
        renderSavedPlans();
        alert(syncedCount + " plan(s) successfully synced to the server!");
    }
}