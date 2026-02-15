const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
const port = 3001;

app.use(cors());
app.use(bodyParser.json());

// --- PostgreSQL Connection Pool ---
const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
    console.error("FATAL ERROR: DATABASE_URL is not defined in environment variables.");
    process.exit(1); 
}

const pool = new Pool({
    connectionString: dbUrl,
    ssl: {
        rejectUnauthorized: false
    }
});

pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
    process.exit(-1);
});

pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('Error connecting to PostgreSQL database', err);
        process.exit(1);
    }
    console.log('Connected to PostgreSQL database at:', res.rows[0].now);
});

// Helper function to generate a simple token
const generateToken = (userId) => {
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
        const bearer = bearerHeader.split(' ');
        const token = bearer[1];
        const userId = getUserIdFromToken(token);

        if (userId) {
            req.userId = userId;
            next();
        } else {
            res.sendStatus(403);
        }
    } else {
        res.sendStatus(401);
    }
};

app.get('/', (req, res) => {
    res.send('GymTracker Backend is running!');
});

// --- User Authentication Routes ---
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send('Username and password are required.');
    try {
        const checkUser = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
        if (checkUser.rows.length > 0) return res.status(409).send('Username already taken.');
        const newUser = await pool.query('INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id', [username, password]);
        res.status(201).send('User registered successfully.');
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).send('Server error during registration.');
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const userResult = await pool.query('SELECT id FROM users WHERE username = $1 AND password = $2', [username, password]);
        const user = userResult.rows[0];
        if (user) {
            const token = generateToken(user.id);
            res.json({ message: 'Login successful', token, userId: user.id });
        } else {
            res.status(401).send('Invalid credentials.');
        }
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).send('Server error during login.');
    }
});

// --- Template Routes ---
app.get('/templates', verifyToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT wt.id, wt.name,
                    json_agg(json_build_object('id', ed.id, 'name', ed.name, 'description', ed.description)) AS exercises
             FROM workout_templates wt
             LEFT JOIN template_exercises te ON wt.id = te.template_id
             LEFT JOIN exercise_definitions ed ON te.exercise_def_id = ed.id
             WHERE wt.user_id = $1
             GROUP BY wt.id, wt.name
             ORDER BY wt.name`,
            [req.userId]
        );
        res.json(result.rows.map(row => ({
            ...row,
            exercises: row.exercises[0]?.id ? row.exercises : []
        })));
    } catch (error) {
        console.error('Get templates error:', error);
        res.status(500).send('Server error fetching templates.');
    }
});

app.post('/templates', verifyToken, async (req, res) => {
    const { name, exercises } = req.body;
    if (!name) return res.status(400).send('Template name is required.');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const newTemplateResult = await client.query('INSERT INTO workout_templates (user_id, name) VALUES ($1, $2) RETURNING id, name', [req.userId, name]);
        const newTemplate = newTemplateResult.rows[0];
        if (exercises && exercises.length > 0) {
            const templateExercisesValues = exercises.map(ex => `('${newTemplate.id}', '${ex.id}')`).join(',');
            await client.query(`INSERT INTO template_exercises (template_id, exercise_def_id) VALUES ${templateExercisesValues}`);
        }
        await client.query('COMMIT');
        const createdTemplate = await pool.query(
            `SELECT wt.id, wt.name,
                    json_agg(json_build_object('id', ed.id, 'name', ed.name, 'description', ed.description)) AS exercises
             FROM workout_templates wt
             LEFT JOIN template_exercises te ON wt.id = te.template_id
             LEFT JOIN exercise_definitions ed ON te.exercise_def_id = ed.id
             WHERE wt.id = $1
             GROUP BY wt.id, wt.name`,
            [newTemplate.id]
        );
        res.status(201).json(createdTemplate.rows[0].exercises[0]?.id ? createdTemplate.rows[0] : { ...createdTemplate.rows[0], exercises: [] });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Create template error:', error);
        res.status(500).send('Server error creating template.');
    } finally {
        client.release();
    }
});

app.get('/templates/:id', verifyToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT wt.id, wt.name,
                    json_agg(json_build_object('id', ed.id, 'name', ed.name, 'description', ed.description)) AS exercises
             FROM workout_templates wt
             LEFT JOIN template_exercises te ON wt.id = te.template_id
             LEFT JOIN exercise_definitions ed ON te.exercise_def_id = ed.id
             WHERE wt.id = $1 AND wt.user_id = $2
             GROUP BY wt.id, wt.name`,
            [req.params.id, req.userId]
        );
        if (result.rows.length > 0) {
            res.json(result.rows[0].exercises[0]?.id ? result.rows[0] : { ...result.rows[0], exercises: [] });
        } else {
            res.status(404).send('Template not found or unauthorized.');
        }
    } catch (error) {
        console.error('Get template by ID error:', error);
        res.status(500).send('Server error fetching template.');
    }
});

app.put('/templates/:id', verifyToken, async (req, res) => {
    const { name, exercises } = req.body;
    if (!name) return res.status(400).send('Template name is required.');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('UPDATE workout_templates SET name = $1 WHERE id = $2 AND user_id = $3', [name, req.params.id, req.userId]);
        await client.query('DELETE FROM template_exercises WHERE template_id = $1', [req.params.id]);
        if (exercises && exercises.length > 0) {
            const templateExercisesValues = exercises.map(ex => `('${req.params.id}', '${ex.id}')`).join(',');
            await client.query(`INSERT INTO template_exercises (template_id, exercise_def_id) VALUES ${templateExercisesValues}`);
        }
        await client.query('COMMIT');
        const updatedTemplate = await pool.query(
            `SELECT wt.id, wt.name,
                    json_agg(json_build_object('id', ed.id, 'name', ed.name, 'description', ed.description)) AS exercises
             FROM workout_templates wt
             LEFT JOIN template_exercises te ON wt.id = te.template_id
             LEFT JOIN exercise_definitions ed ON te.exercise_def_id = ed.id
             WHERE wt.id = $1
             GROUP BY wt.id, wt.name`,
            [req.params.id]
        );
        res.json(updatedTemplate.rows[0].exercises[0]?.id ? updatedTemplate.rows[0] : { ...updatedTemplate.rows[0], exercises: [] });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Update template error:', error);
        res.status(500).send('Server error updating template.');
    } finally {
        client.release();
    }
});

app.delete('/templates/:id', verifyToken, async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM workout_templates WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, req.userId]);
        if (result.rows.length > 0) {
            res.status(204).send();
        } else {
            res.status(404).send('Template not found or unauthorized.');
        }
    } catch (error) {
        console.error('Delete template error:', error);
        res.status(500).send('Server error deleting template.');
    }
});

app.get('/exercise-definitions', verifyToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name, description FROM exercise_definitions WHERE user_id = $1 ORDER BY name', [req.userId]);
        res.json(result.rows);
    } catch (error) {
        console.error('Get exercise definitions error:', error);
        res.status(500).send('Server error fetching exercise definitions.');
    }
});

app.post('/exercise-definitions', verifyToken, async (req, res) => {
    const { name, description } = req.body;
    if (!name) return res.status(400).send('Exercise name is required.');
    try {
        const newExerciseDefinition = await pool.query('INSERT INTO exercise_definitions (user_id, name, description) VALUES ($1, $2, $3) RETURNING id, name, description', [req.userId, name, description || '']);
        res.status(201).json(newExerciseDefinition.rows[0]);
    } catch (error) {
        console.error('Create exercise definition error:', error);
        if (error.code === '23505') return res.status(409).send('Exercise with this name already exists for this user.');
        res.status(500).send('Server error creating exercise definition.');
    }
});

app.get('/workouts', verifyToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT ws.id, ws.date,
                    json_agg(
                        json_build_object(
                            'id', ce.id,
                            'exerciseDefinitionId', ce.exercise_def_id,
                            'exerciseName', ce.exercise_name,
                            'sets', (SELECT json_agg(json_build_object('id', es.id, 'reps', es.reps, 'weight', es.weight))
                                     FROM exercise_sets es
                                     WHERE es.completed_exercise_id = ce.id)
                        )
                    ) AS completedExercises
             FROM workout_sessions ws
             LEFT JOIN completed_exercises ce ON ws.id = ce.session_id
             WHERE ws.user_id = $1
             GROUP BY ws.id, ws.date
             ORDER BY ws.date DESC`,
            [req.userId]
        );
        const workouts = result.rows.map(row => ({
            ...row,
            completedExercises: row.completedExercises[0]?.id ? row.completedExercises : []
        }));
        res.json(workouts);
    } catch (error) {
        console.error('Get workouts error:', error);
        res.status(500).send('Server error fetching workouts.');
    }
});

app.post('/workouts', verifyToken, async (req, res) => {
    const { date, completedExercises } = req.body;
    if (!date || !completedExercises) return res.status(400).send('Date and completed exercises are required.');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const newSessionResult = await client.query('INSERT INTO workout_sessions (user_id, date) VALUES ($1, $2) RETURNING id', [req.userId, date]);
        const sessionId = newSessionResult.rows[0].id;
        for (const ce of completedExercises) {
            const newCompletedExerciseResult = await client.query('INSERT INTO completed_exercises (session_id, exercise_def_id, exercise_name) VALUES ($1, $2, $3) RETURNING id', [sessionId, ce.exerciseDefinitionId, ce.exerciseName]);
            const completedExerciseId = newCompletedExerciseResult.rows[0].id;
            for (const set of ce.sets) {
                await client.query('INSERT INTO exercise_sets (completed_exercise_id, reps, weight) VALUES ($1, $2, $3)', [completedExerciseId, set.reps, set.weight]);
            }
        }
        await client.query('COMMIT');
        res.status(201).send('Workout session created successfully.');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Create workout session error:', error);
        res.status(500).send('Server error creating workout session.');
    } finally {
        client.release();
    }
});

app.get('/workouts/:id', verifyToken, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT ws.id, ws.date,
                    json_agg(
                        json_build_object(
                            'id', ce.id,
                            'exerciseDefinitionId', ce.exercise_def_id,
                            'exerciseName', ce.exercise_name,
                            'sets', (SELECT json_agg(json_build_object('id', es.id, 'reps', es.reps, 'weight', es.weight))
                                     FROM exercise_sets es
                                     WHERE es.completed_exercise_id = ce.id)
                        )
                    ) AS completedExercises
             FROM workout_sessions ws
             LEFT JOIN completed_exercises ce ON ws.id = ce.session_id
             WHERE ws.id = $1 AND ws.user_id = $2
             GROUP BY ws.id, ws.date`,
            [req.params.id, req.userId]
        );
        if (result.rows.length > 0) {
            const workout = result.rows[0];
            res.json({
                ...workout,
                completedExercises: workout.completedExercises[0]?.id ? workout.completedExercises : []
            });
        } else {
            res.status(404).send('Workout session not found or unauthorized.');
        }
    } catch (error) {
        console.error('Get workout session by ID error:', error);
        res.status(500).send('Server error fetching workout session.');
    }
});

app.get('/workouts/last-exercise/:exerciseDefId', verifyToken, async (req, res) => {
    const { exerciseDefId } = req.params;
    try {
        const lastExerciseResult = await pool.query(
            `SELECT ce.id, ws.date
             FROM completed_exercises ce
             JOIN workout_sessions ws ON ce.session_id = ws.id
             WHERE ce.exercise_def_id = $1 AND ws.user_id = $2
             ORDER BY ws.date DESC
             LIMIT 1`,
            [exerciseDefId, req.userId]
        );
        if (lastExerciseResult.rows.length > 0) {
            const lastCompletedExerciseId = lastExerciseResult.rows[0].id;
            const lastSessionDate = lastExerciseResult.rows[0].date;
            const setsResult = await pool.query('SELECT id, reps, weight FROM exercise_sets WHERE completed_exercise_id = $1 ORDER BY created_at ASC', [lastCompletedExerciseId]);
            res.json({ sets: setsResult.rows, date: lastSessionDate });
        } else {
            res.status(404).send('No previous data for this exercise found.');
        }
    } catch (error) {
        console.error('Get last exercise data error:', error);
        res.status(500).send('Server error fetching last exercise data.');
    }
});

app.delete('/workouts/:id', verifyToken, async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM workout_sessions WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, req.userId]);
        if (result.rows.length > 0) {
            res.status(204).send();
        } else {
            res.status(404).send('Workout session not found or unauthorized.');
        }
    } catch (error) {
        console.error('Delete workout session error:', error);
        res.status(500).send('Server error deleting workout session.');
    }
});

app.listen(port, () => {
    console.log(`Backend server listening at http://localhost:${port}`);
});
