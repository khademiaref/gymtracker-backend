
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const crypto = require('crypto'); // For basic token generation

const app = express();
const port = 3001; // Using a different port than React's default 3000

// Use cors middleware
app.use(cors());

// Use body-parser middleware
app.use(bodyParser.json());

// Configure lowdb to write to FileSync
const adapter = new FileSync('db.json');
const db = low(adapter);

// Set default data if the file is empty
db.defaults({
    users: [],
    workouts: [],
    templates: [],
    exerciseDefinitions: []
}).write();

// Helper function to generate a simple token
// In a real app, this would be a proper JWT with a payload containing user ID.
const generateToken = (userId) => {
    // For simplicity, we're just encoding the userId in the token.
    // In production, use a library like 'jsonwebtoken' with a secret key.
    return Buffer.from(`${userId}:${crypto.randomBytes(8).toString('hex')}`).toString('base64');
};

// Helper function to decode token and get userId
const getUserIdFromToken = (token) => {
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf8');
        const [userId] = decoded.split(':');
        return userId;
    } catch (e) {
        return null;
    }
};

// Middleware to verify token and attach user ID
const verifyToken = (req, res, next) => {
    const bearerHeader = req.headers['authorization'];
    if (typeof bearerHeader !== 'undefined') {
        const bearer = bearerHeader.split(' '); // Expected format: Bearer <token>
        const token = bearer[1];
        const userId = getUserIdFromToken(token);

        if (userId) {
            req.userId = userId; // Attach userId to the request
            next();
        } else {
            res.sendStatus(403); // Forbidden, invalid token
        }
    } else {
        res.sendStatus(401); // Unauthorized, no token provided
    }
};

// Basic route
app.get('/', (req, res) => {
    res.send('GymTracker Backend is running!');
});

// --- User Authentication Routes ---

// Register new user
app.post('/register', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).send('Username and password are required.');
    }

    const userExists = db.get('users').find({ username }).value();
    if (userExists) {
        return res.status(409).send('Username already taken.');
    }

    // In a real application, passwords should ALWAYS be hashed and salted (e.g., using bcrypt).
    // For this prototype, we're storing plaintext passwords.
    const newUser = { id: Date.now().toString(), username, password };
    db.get('users').push(newUser).write();

    res.status(201).send('User registered successfully.');
});

// Login user
app.post('/login', (req, res) => {
    const { username, password } = req.body;

    const user = db.get('users').find({ username, password }).value();

    if (user) {
        // In a real application, a secure JWT (JSON Web Token) should be generated
        // and signed with a strong secret key, and stored securely on the client.
        const token = generateToken(user.id); 
        res.json({ message: 'Login successful', token, userId: user.id });
    } else {
        res.status(401).send('Invalid credentials.');
    }
});

// --- Template Routes ---

// Get all templates for the authenticated user
app.get('/templates', verifyToken, (req, res) => {
    const userTemplates = db.get('templates').filter({ userId: req.userId }).value();
    res.json(userTemplates);
});

// Create a new template
app.post('/templates', verifyToken, (req, res) => {
    const { name, exercises } = req.body; // exercises would be an array of exerciseDefinition objects or IDs

    if (!name) {
        return res.status(400).send('Template name is required.');
    }

    const newTemplate = {
        id: Date.now().toString(),
        userId: req.userId, // Associate with the authenticated user
        name,
        exercises: exercises || [] // Store exercises associated with this template
    };
    db.get('templates').push(newTemplate).write();

    res.status(201).json(newTemplate);
});

// Get a specific template by ID
app.get('/templates/:id', verifyToken, (req, res) => {
    const template = db.get('templates').find({ id: req.params.id, userId: req.userId }).value();
    if (template) {
        res.json(template);
    } else {
        res.status(404).send('Template not found or unauthorized.');
    }
});

// Update a template
app.put('/templates/:id', verifyToken, (req, res) => {
    const { name, exercises } = req.body;
    const updatedTemplate = db.get('templates')
        .find({ id: req.params.id, userId: req.userId })
        .assign({ name, exercises: exercises || [] })
        .write();

    if (updatedTemplate) {
        res.json(updatedTemplate);
    } else {
        res.status(404).send('Template not found or unauthorized.');
    }
});

// Delete a template
app.delete('/templates/:id', verifyToken, (req, res) => {
    db.get('templates')
        .remove({ id: req.params.id, userId: req.userId })
        .write();
    res.status(204).send(); // No Content
});

// --- Exercise Definition Routes ---

// Get all exercise definitions for the authenticated user
app.get('/exercise-definitions', verifyToken, (req, res) => {
    const userExerciseDefinitions = db.get('exerciseDefinitions').filter({ userId: req.userId }).value();
    res.json(userExerciseDefinitions);
});

// Create a new exercise definition
app.post('/exercise-definitions', verifyToken, (req, res) => {
    const { name, description } = req.body;

    if (!name) {
        return res.status(400).send('Exercise name is required.');
    }

    const newExerciseDefinition = {
        id: Date.now().toString(),
        userId: req.userId,
        name,
        description: description || ''
    };
    db.get('exerciseDefinitions').push(newExerciseDefinition).write();

    res.status(201).json(newExerciseDefinition);
});

// --- Workout Session Routes ---

// Get all workout sessions for the authenticated user
app.get('/workouts', verifyToken, (req, res) => {
    const userWorkouts = db.get('workouts').filter({ userId: req.userId }).sortBy('date').reverse().value();
    res.json(userWorkouts);
});

// Create a new workout session
app.post('/workouts', verifyToken, (req, res) => {
    const { date, completedExercises } = req.body;

    if (!date || !completedExercises) {
        return res.status(400).send('Date and completed exercises are required.');
    }

    const newWorkoutSession = {
        id: Date.now().toString(),
        userId: req.userId,
        date, // ISO string
        completedExercises: completedExercises.map(ce => ({
            ...ce,
            id: Date.now().toString() + Math.random().toString(36).substring(7), // Unique ID for each completed exercise
            sets: ce.sets.map(s => ({
                ...s,
                id: Date.now().toString() + Math.random().toString(36).substring(7) // Unique ID for each set
            }))
        }))
    };
    db.get('workouts').push(newWorkoutSession).write();

    res.status(201).json(newWorkoutSession);
});

// Get a specific workout session by ID
app.get('/workouts/:id', verifyToken, (req, res) => {
    const workout = db.get('workouts').find({ id: req.params.id, userId: req.userId }).value();
    if (workout) {
        res.json(workout);
    } else {
        res.status(404).send('Workout session not found or unauthorized.');
    }
});

// Get the last completed sets for a specific exercise definition
app.get('/workouts/last-exercise/:exerciseDefId', verifyToken, (req, res) => {
    const { exerciseDefId } = req.params;
    
    // Find all workout sessions for the user
    const userWorkouts = db.get('workouts').filter({ userId: req.userId }).sortBy('date').reverse().value();

    let lastCompletedSets = [];
    let lastSessionDate = null;

    // Iterate through workouts to find the most recent instance of the exercise
    for (const workout of userWorkouts) {
        const foundExercise = workout.completedExercises.find(ce => ce.exerciseDefinitionId === exerciseDefId);
        if (foundExercise) {
            lastCompletedSets = foundExercise.sets;
            lastSessionDate = workout.date;
            break; // Found the most recent one, so stop
        }
    }

    if (lastCompletedSets.length > 0) {
        res.json({ sets: lastCompletedSets, date: lastSessionDate });
    } else {
        res.status(404).send('No previous data for this exercise found.');
    }
});
