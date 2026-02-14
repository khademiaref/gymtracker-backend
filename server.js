const express = require('express');
     2     const cors = require('cors');
     3     const bodyParser = require('body-parser');
     4     const { Pool } = require('pg');
     5     const crypto = require('crypto');
     6
     7     const app = express();
     8     const port = 3001;
     9
    10     app.use(cors());
    11     app.use(bodyParser.json());
    12
    13     // --- PostgreSQL Connection Pool ---
    14     const pool = new Pool({
    15         connectionString: process.env.DATABASE_URL,
    16         ssl: {
    17             rejectUnauthorized: false
    18         }
    19     });
    20
    21     pool.on('error', (err) => {
    22         console.error('Unexpected error on idle client', err);
    23         process.exit(-1);
    24     });
    25
    26     pool.query('SELECT NOW()', (err, res) => {
    27         if (err) {
    28             console.error('Error connecting to PostgreSQL database', err);
    29             process.exit(1);
    30         }
    31         console.log('Connected to PostgreSQL database at:', res.rows[0].now);
    32     });
    33
    34     // Helper function to generate a simple token
    35     const generateToken = (userId) => {
    36         return Buffer.from(`${userId}:${crypto.randomBytes(8).toString('hex')}`).toString('base64');
    37     };
    38
    39     // Helper function to decode token and get userId
    40     const getUserIdFromToken = (token) => {
    41         try {
    42             const decoded = Buffer.from(token, 'base64').toString('utf8');
    43             const [userId] = decoded.split(':');
    44             return userId;
    45         } catch (e) {
    46             return null;
    47         }
    48     };
    49
    50     // Middleware to verify token and attach user ID
    51     const verifyToken = (req, res, next) => {
    52         const bearerHeader = req.headers['authorization'];
    53         if (typeof bearerHeader !== 'undefined') {
    54             const bearer = bearerHeader.split(' ');
    55             const token = bearer[1];
    56             const userId = getUserIdFromToken(token);
    57
    58             if (userId) {
    59                 req.userId = userId;
    60                 next();
    61             } else {
    62                 res.sendStatus(403);
    63             }
    64         } else {
    65             res.sendStatus(401);
    66         }
    67     };
    68
    69     app.get('/', (req, res) => {
    70         res.send('GymTracker Backend is running!');
    71     });
    72
    73     // --- User Authentication Routes ---
    74     app.post('/register', async (req, res) => {
    75         const { username, password } = req.body;
    76         if (!username || !password) return res.status(400).send('Username and password are required.');
    77         try {
    78             const checkUser = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    79             if (checkUser.rows.length > 0) return res.status(409).send('Username already taken.');
    80             const newUser = await pool.query('INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id',
       [username, password]);
    81             res.status(201).send('User registered successfully.');
    82         } catch (error) {
    83             console.error('Registration error:', error);
    84             res.status(500).send('Server error during registration.');
    85         }
    86     });
    87
    88     app.post('/login', async (req, res) => {
    89         const { username, password } = req.body;
    90         try {
    91             const userResult = await pool.query('SELECT id FROM users WHERE username = $1 AND password = $2',
       [username, password]);
    92             const user = userResult.rows[0];
    93             if (user) {
    94                 const token = generateToken(user.id);
    95                 res.json({ message: 'Login successful', token, userId: user.id });
    96             } else {
    97                 res.status(401).send('Invalid credentials.');
    98             }
    99         } catch (error) {
   100             console.error('Login error:', error);
   101             res.status(500).send('Server error during login.');
   102         }
   103     });
   104
   105     // --- Template Routes ---
   106     app.get('/templates', verifyToken, async (req, res) => {
   107         try {
   108             const result = await pool.query(
   109                 `SELECT wt.id, wt.name,
   110                         json_agg(json_build_object('id', ed.id, 'name', ed.name, 'description', ed.description)) AS
       exercises
   111                  FROM workout_templates wt
   112                  LEFT JOIN template_exercises te ON wt.id = te.template_id
   113                  LEFT JOIN exercise_definitions ed ON te.exercise_def_id = ed.id
   114                  WHERE wt.user_id = $1
   115                  GROUP BY wt.id, wt.name
   116                  ORDER BY wt.name`,
   117                 [req.userId]
   118             );
   119             res.json(result.rows.map(row => ({
   120                 ...row,
   121                 exercises: row.exercises[0]?.id ? row.exercises : []
   122             })));
   123         } catch (error) {
   124             console.error('Get templates error:', error);
   125             res.status(500).send('Server error fetching templates.');
   126         }
   127     });
   128
   129     app.post('/templates', verifyToken, async (req, res) => {
   130         const { name, exercises } = req.body;
   131         if (!name) return res.status(400).send('Template name is required.');
   132         const client = await pool.connect();
   133         try {
   134             await client.query('BEGIN');
   135             const newTemplateResult = await client.query('INSERT INTO workout_templates (user_id, name) VALUES ($1,
       $2) RETURNING id, name', [req.userId, name]);
   136             const newTemplate = newTemplateResult.rows[0];
   137             if (exercises && exercises.length > 0) {
   138                 const templateExercisesValues = exercises.map(ex => `('${newTemplate.id}', '${ex.id}')`).join(',');
   139                 await client.query(`INSERT INTO template_exercises (template_id, exercise_def_id) VALUES
       ${templateExercisesValues}`);
   140             }
   141             await client.query('COMMIT');
   142             const createdTemplate = await pool.query(
   143                 `SELECT wt.id, wt.name,
   144                         json_agg(json_build_object('id', ed.id, 'name', ed.name, 'description', ed.description)) AS
       exercises
   145                  FROM workout_templates wt
   146                  LEFT JOIN template_exercises te ON wt.id = te.template_id
   147                  LEFT JOIN exercise_definitions ed ON te.exercise_def_id = ed.id
   148                  WHERE wt.id = $1
   149                  GROUP BY wt.id, wt.name`,
   150                 [newTemplate.id]
   151             );
   152             res.status(201).json(createdTemplate.rows[0].exercises[0]?.id ? createdTemplate.rows[0] : {
       ...createdTemplate.rows[0], exercises: [] });
   153         } catch (error) {
   154             await client.query('ROLLBACK');
   155             console.error('Create template error:', error);
   156             res.status(500).send('Server error creating template.');
   157         } finally {
   158             client.release();
   159         }
   160     });
   161
   162     app.get('/templates/:id', verifyToken, async (req, res) => {
   163         try {
   164             const result = await pool.query(
   165                 `SELECT wt.id, wt.name,
   166                         json_agg(json_build_object('id', ed.id, 'name', ed.name, 'description', ed.description)) AS
       exercises
   167                  FROM workout_templates wt
   168                  LEFT JOIN template_exercises te ON wt.id = te.template_id
   169                  LEFT JOIN exercise_definitions ed ON te.exercise_def_id = ed.id
   170                  WHERE wt.id = $1 AND wt.user_id = $2
   171                  GROUP BY wt.id, wt.name`,
   172                 [req.params.id, req.userId]
   173             );
   174             if (result.rows.length > 0) {
   175                 res.json(result.rows[0].exercises[0]?.id ? result.rows[0] : { ...result.rows[0], exercises: [] });
   176             } else {
   177                 res.status(404).send('Template not found or unauthorized.');
   178             }
   179         } catch (error) {
   180             console.error('Get template by ID error:', error);
   181             res.status(500).send('Server error fetching template.');
   182         }
   183     });
   184
   185     app.put('/templates/:id', verifyToken, async (req, res) => {
   186         const { name, exercises } = req.body;
   187         if (!name) return res.status(400).send('Template name is required.');
   188         const client = await pool.connect();
   189         try {
   190             await client.query('BEGIN');
   191             await client.query('UPDATE workout_templates SET name = $1 WHERE id = $2 AND user_id = $3', [name,
       req.params.id, req.userId]);
   192             await client.query('DELETE FROM template_exercises WHERE template_id = $1', [req.params.id]);
   193             if (exercises && exercises.length > 0) {
   194                 const templateExercisesValues = exercises.map(ex => `('${req.params.id}', '${ex.id}')`).join(',');
   195                 await client.query(`INSERT INTO template_exercises (template_id, exercise_def_id) VALUES
       ${templateExercisesValues}`);
   196             }
   197             await client.query('COMMIT');
   198             const updatedTemplate = await pool.query(
   199                 `SELECT wt.id, wt.name,
   200                         json_agg(json_build_object('id', ed.id, 'name', ed.name, 'description', ed.description)) AS
       exercises
   201                  FROM workout_templates wt
   202                  LEFT JOIN template_exercises te ON wt.id = te.template_id
   203                  LEFT JOIN exercise_definitions ed ON te.exercise_def_id = ed.id
   204                  WHERE wt.id = $1
   205                  GROUP BY wt.id, wt.name`,
   206                 [req.params.id]
   207             );
   208             res.json(updatedTemplate.rows[0].exercises[0]?.id ? updatedTemplate.rows[0] : {
       ...updatedTemplate.rows[0], exercises: [] });
   209         } catch (error) {
   210             await client.query('ROLLBACK');
   211             console.error('Update template error:', error);
   212             res.status(500).send('Server error updating template.');
   213         } finally {
   214             client.release();
   215         }
   216     });
   217
   218     app.delete('/templates/:id', verifyToken, async (req, res) => {
   219         try {
   220             const result = await pool.query('DELETE FROM workout_templates WHERE id = $1 AND user_id = $2 RETURNING
       id', [req.params.id, req.userId]);
   221             if (result.rows.length > 0) {
   222                 res.status(204).send();
   223             } else {
   224                 res.status(404).send('Template not found or unauthorized.');
   225             }
   226         } catch (error) {
   227             console.error('Delete template error:', error);
   228             res.status(500).send('Server error deleting template.');
   229         }
   230     });
   231
   232     // --- Exercise Definition Routes ---
   233     app.get('/exercise-definitions', verifyToken, async (req, res) => {
   234         try {
   235             const result = await pool.query('SELECT id, name, description FROM exercise_definitions WHERE user_id =
       ORDER BY name', [req.userId]);
   236             res.json(result.rows);
   237         } catch (error) {
   238             console.error('Get exercise definitions error:', error);
   239             res.status(500).send('Server error fetching exercise definitions.');
   240         }
   241     });
   242
   243     app.post('/exercise-definitions', verifyToken, async (req, res) => {
   244         const { name, description } = req.body;
   245         if (!name) return res.status(400).send('Exercise name is required.');
   246         try {
   247             const newExerciseDefinition = await pool.query('INSERT INTO exercise_definitions (user_id, name,
       description) VALUES ($1, $2, $3) RETURNING id, name, description', [req.userId, name, description || '']);
   248             res.status(201).json(newExerciseDefinition.rows[0]);
   249         } catch (error) {
   250             console.error('Create exercise definition error:', error);
   251             if (error.code === '23505') return res.status(409).send('Exercise with this name already exists for this
       user.');
   252             res.status(500).send('Server error creating exercise definition.');
   253         }
   254     });
   255
   256     // --- Workout Session Routes ---
   257     app.get('/workouts', verifyToken, async (req, res) => {
   258         try {
   259             const result = await pool.query(
   260                 `SELECT ws.id, ws.date,
   261                         json_agg(
   262                             json_build_object(
   263                                 'id', ce.id,
   264                                 'exerciseDefinitionId', ce.exercise_def_id,
   265                                 'exerciseName', ce.exercise_name,
   266                                 'sets', (SELECT json_agg(json_build_object('id', es.id, 'reps', es.reps, 'weight',
       es.weight))
   267                                          FROM exercise_sets es
   268                                          WHERE es.completed_exercise_id = ce.id)
   269                             )
   270                         ) AS completedExercises
   271                  FROM workout_sessions ws
   272                  LEFT JOIN completed_exercises ce ON ws.id = ce.session_id
   273                  WHERE ws.user_id = $1
   274                  GROUP BY ws.id, ws.date
   275                  ORDER BY ws.date DESC`,
   276                 [req.userId]
   277             );
   278             const workouts = result.rows.map(row => ({
   279                 ...row,
   280                 completedExercises: row.completedExercises[0]?.id ? row.completedExercises : []
   281             }));
   282             res.json(workouts);
   283         } catch (error) {
   284             console.error('Get workouts error:', error);
   285             res.status(500).send('Server error fetching workouts.');
   286         }
   287     });
   288
   289     app.post('/workouts', verifyToken, async (req, res) => {
   290         const { date, completedExercises } = req.body;
   291         if (!date || !completedExercises) return res.status(400).send('Date and completed exercises are required.');
   292         const client = await pool.connect();
   293         try {
   294             await client.query('BEGIN');
   295             const newSessionResult = await client.query('INSERT INTO workout_sessions (user_id, date) VALUES ($1, $2
       RETURNING id', [req.userId, date]);
   296             const sessionId = newSessionResult.rows[0].id;
   297             for (const ce of completedExercises) {
   298                 const newCompletedExerciseResult = await client.query('INSERT INTO completed_exercises (session_id,
       exercise_def_id, exercise_name) VALUES ($1, $2, $3) RETURNING id', [sessionId, ce.exerciseDefinitionId,
       ce.exerciseName]);
   299                 const completedExerciseId = newCompletedExerciseResult.rows[0].id;
   300                 for (const set of ce.sets) {
   301                     await client.query('INSERT INTO exercise_sets (completed_exercise_id, reps, weight) VALUES ($1,
       $2, $3)', [completedExerciseId, set.reps, set.weight]);
   302                 }
   303             }
   304             await client.query('COMMIT');
   305             res.status(201).send('Workout session created successfully.');
   306         } catch (error) {
   307             await client.query('ROLLBACK');
   308             console.error('Create workout session error:', error);
   309             res.status(500).send('Server error creating workout session.');
   310         } finally {
   311             client.release();
   312         }
   313     });
   314
   315     app.get('/workouts/:id', verifyToken, async (req, res) => {
   316         try {
   317             const result = await pool.query(
   318                 `SELECT ws.id, ws.date,
   319                         json_agg(
   320                             json_build_object(
   321                                 'id', ce.id,
   322                                 'exerciseDefinitionId', ce.exercise_def_id,
   323                                 'exerciseName', ce.exercise_name,
   324                                 'sets', (SELECT json_agg(json_build_object('id', es.id, 'reps', es.reps, 'weight',
       es.weight))
   325                                          FROM exercise_sets es
   326                                          WHERE es.completed_exercise_id = ce.id)
   327                             )
   328                         ) AS completedExercises
   329                  FROM workout_sessions ws
   330                  LEFT JOIN completed_exercises ce ON ws.id = ce.session_id
   331                  WHERE ws.id = $1 AND ws.user_id = $2
   332                  GROUP BY ws.id, ws.date`,
   333                 [req.params.id, req.userId]
   334             );
   335             if (result.rows.length > 0) {
   336                 const workout = result.rows[0];
   337                 res.json({
   338                     ...workout,
   339                     completedExercises: workout.completedExercises[0]?.id ? workout.completedExercises : []
   340                 });
   341             } else {
   342                 res.status(404).send('Workout session not found or unauthorized.');
   343             }
   344         } catch (error) {
   345             console.error('Get workout session by ID error:', error);
   346             res.status(500).send('Server error fetching workout session.');
   347         }
   348     });
   349
   350     app.get('/workouts/last-exercise/:exerciseDefId', verifyToken, async (req, res) => {
   351         const { exerciseDefId } = req.params;
   352         try {
   353             const lastExerciseResult = await pool.query(
   354                 `SELECT ce.id, ws.date
   355                  FROM completed_exercises ce
   356                  JOIN workout_sessions ws ON ce.session_id = ws.id
   357                  WHERE ce.exercise_def_id = $1 AND ws.user_id = $2
   358                  ORDER BY ws.date DESC
   359                  LIMIT 1`,
   360                 [exerciseDefId, req.userId]
   361             );
   362             if (lastExerciseResult.rows.length > 0) {
   363                 const lastCompletedExerciseId = lastExerciseResult.rows[0].id;
   364                 const lastSessionDate = lastExerciseResult.rows[0].date;
   365                 const setsResult = await pool.query('SELECT id, reps, weight FROM exercise_sets WHERE
       completed_exercise_id = $1 ORDER BY created_at ASC', [lastCompletedExerciseId]);
   366                 res.json({ sets: setsResult.rows, date: lastSessionDate });
   367             } else {
   368                 res.status(404).send('No previous data for this exercise found.');
   369             }
   370         } catch (error) {
   371             console.error('Get last exercise data error:', error);
   372             res.status(500).send('Server error fetching last exercise data.');
   373         }
   374     });
   375
   376     app.delete('/workouts/:id', verifyToken, async (req, res) => {
   377         try {
   378             const result = await pool.query('DELETE FROM workout_sessions WHERE id = $1 AND user_id = $2 RETURNING
       id', [req.params.id, req.userId]);
   379             if (result.rows.length > 0) {
   380                 res.status(204).send();
   381             } else {
   382                 res.status(404).send('Workout session not found or unauthorized.');
   383             }
   384         } catch (error) {
   385             console.error('Delete workout session error:', error);
   386             res.status(500).send('Server error deleting workout session.');
   387         }
   388     });
   389
   390     app.listen(port, () => {
   391         console.log(`Backend server listening at http://localhost:${port}`);
   392     });