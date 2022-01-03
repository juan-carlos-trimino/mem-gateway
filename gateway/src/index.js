/***
Gateway/Reverse Proxy
The gateway is the entry point to the app; it provides a REST API so the front end can interact
with the backend.
***/
const express = require('express');
const path = require('path');
const http = require('http');
const { randomUUID } = require('crypto');
const winston = require('winston');

/******
Globals
******/
//Create a new express instance.
const app = express();
const SVC_NAME = "gateway";
const SVC_DNS_METADATA = process.env.SVC_DNS_METADATA;
const SVC_DNS_HISTORY = process.env.SVC_DNS_HISTORY;
const SVC_DNS_VIDEO_UPLOAD = process.env.SVC_DNS_VIDEO_UPLOAD;
const SVC_DNS_VIDEO_STREAMING = process.env.SVC_DNS_VIDEO_STREAMING;
const PORT = process.env.PORT && parseInt(process.env.PORT) || 3000;
const MAX_RETRIES = process.env.MAX_RETRIES && parseInt(process.env.MAX_RETRIES) || 10;
let READINESS_PROBE = false;

/***
Resume Operation
----------------
The resume operation strategy intercepts unexpected errors and responds by allowing the process to
continue.
***/
process.on('uncaughtException',
err => {
  logger.error(`${SVC_NAME} - Uncaught exception.`);
  logger.error(`${SVC_NAME} - ${err}`);
  logger.error(`${SVC_NAME} - ${err.stack}`);
})

/***
Abort and Restart
-----------------
***/
// process.on("uncaughtException",
// err => {
//   console.error("Uncaught exception:");
//   console.error(err && err.stack || err);
//   process.exit(1);
// })

//Winston requires at least one transport (location to save the log) to create a log.
const logConfiguration = {
  transports: [ new winston.transports.Console() ],
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSSSS' }),
    winston.format.printf(msg => `${msg.timestamp} ${msg.level} ${msg.message}`)
  ),
  exitOnError: false
}

//Create a logger and pass it the Winston configuration object.
const logger = winston.createLogger(logConfiguration);

/***
Unlike most other programming languages or runtime environments, Node.js doesn't have a built-in
special "main" function to designate the entry point of a program.

Accessing the main module
-------------------------
When a file is run directly from Node.js, require.main is set to its module. That means that it is
possible to determine whether a file has been run directly by testing require.main === module.
***/
if (require.main === module) {
  main()
  .then(() => {
    READINESS_PROBE = true;
    logger.info(`${SVC_NAME} - Microservice is listening on port "${PORT}"!`);
  })
  .catch(err => {
    logger.error(`${SVC_NAME} - Microservice failed to start.`);
    logger.error(`${SVC_NAME} - ${err}`);
    logger.error(`${SVC_NAME} - ${err.stack}`);
  });
}

function main() {
  //Throw an exception if any required environment variables are missing.
  if (process.env.SVC_DNS_METADATA === undefined) {
    throw new Error('Please specify the service DNS in the environment variable SVC_DNS_METADATA.');
  }
  else if (process.env.SVC_DNS_HISTORY === undefined) {
    throw new Error('Please specify the service DNS in the environment variable SVC_DNS_HISTORY.');
  }
  else if (process.env.SVC_DNS_VIDEO_UPLOAD === undefined) {
    throw new Error('Please specify the service DNS in the environment variable SVC_DNS_VIDEO_UPLOAD.');
  }
  else if (process.env.SVC_DNS_VIDEO_STREAMING === undefined) {
    throw new Error('Please specify the service DNS in the environment variable SVC_DNS_VIDEO_STREAMING.');
  }
  //Display a message if any optional environment variables are missing.
  else {
    if (process.env.PORT === undefined) {
      logger.info(`${SVC_NAME} - The environment variable PORT for the HTTP server is missing; using port ${PORT}.`);
    }
    //
    if (process.env.MAX_RETRIES === undefined) {
      logger.info(`${SVC_NAME} - The environment variable MAX_RETRIES is missing; using MAX_RETRIES=${MAX_RETRIES}.`);
    }
  }
  //Notify when server has started.
  return new Promise(resolve => {
    //Set directory that contains templates for views.
    app.set('views', path.join(__dirname, 'views'));
    //Use hbs as the view engine for Express.
    app.set('view engine', 'hbs');
    app.use(express.static("public"));
    app.listen(PORT,
    () => {
      resolve();  //HTTP server is listening, resolve the promise.
    });
  });
}

//Readiness probe.
app.get('/readiness',
(req, res) => {
  const options = {
    host: SVC_DNS_METADATA,
    path: '/readiness',
    method: 'GET'
  };
  //Check upstream dependencies.
  http.request(options,
  (response) => {
    if (response.statusCode === 200) {
      READINESS_PROBE = true;
      res.sendStatus(200);
    }
    else {
      READINESS_PROBE = false;
      logger.info(`${SVC_NAME} - Upstream dependency ${SVC_DNS_METADATA} not ready.`);
      res.sendStatus(500);
    }
  })
  .on('error',
  err => {
    READINESS_PROBE = false;
    logger.info(`${SVC_NAME} - Upstream dependency ${SVC_DNS_METADATA} not ready.`);
    res.sendStatus(500);
  })
  .end();  //Finalize the request.
});

//Main web page for listing videos.
app.get('/',
(req, res) => {
  const cid = randomUUID();
  logger.info(`${SVC_NAME} ${cid} - Received request for the "List the Videos".`);
  /***
  In the HTTP protocol, headers are case-insensitive; however, the Express framework converts
  everything to lower case. Unfortunately, for objects in JavaScript, their property names are
  case-sensitive.
  ***/
  const options = {
    host: SVC_DNS_METADATA,
    path: '/videos',
    method: 'GET',
    headers: {
      'x-correlation-id': cid
    }
  };
  //Get the list of videos from the metadata microservice.
  http.request(options,
  (response) => {
    let data = '';
    response.on('data',
    chunk => {
      data += chunk;
    });
    response.on('end',
    () => {
      /***
      An empty string is not a valid JSON string; JSON.parse(''); will not parse correctly.
      While an empty string is not valid JSON, two quotes is valid JSON; JSON.parse('""');
      will parse correctly.
      Valid minimal JSON strings are:
        The empty object '{}'
        The empty array '[]'
        The string that is empty '""'
        A number; e.g., '123.4'
        The boolean value true 'true'
        The boolean value false 'false'
        The null value 'null'
      ***/
      //Render the video list for display in the browser.
      if (response.statusCode === 500 || data === undefined || data === null || data === '') {
        res.render('video-list', { videos: JSON.parse('[]') });
      }
      else {
        res.render('video-list', { videos: JSON.parse(data).videos });
      }
    });
    response.on('error',
    err => {
      logger.error(`${SVC_NAME} ${cid} - Failed to retrieve the video collection.`);
      logger.error(`${SVC_NAME} ${cid} - ${err}`);
      res.sendStatus(500);
    });
  })
  .on('error',
  err => {
    logger.error(`${SVC_NAME} ${cid} - Failed to retrieve the video collection.`);
    logger.error(`${SVC_NAME} ${cid} - ${err}`);
    res.sendStatus(500);
  })
  .end();
});

//Web page for playing a particular video.
app.get('/video',
(req, res) => {
  const cid = randomUUID();
  const videoId = req.query.id;
  logger.info(`${SVC_NAME} ${cid} - Starting the request: Play Video ${videoId}.`);
  //Get the selected video from the metadata microservice.
  http.request({
    host: SVC_DNS_METADATA,
    path: `/video?id=${videoId}`,
    method: 'GET',
    headers: {
      'x-correlation-id': cid
    }
  },
  (response) => {
    let data = '';
    response.on('data',
    chunk => {
      data += chunk;
    });
    response.on('end',
    () => {
      try {
        const metadata = JSON.parse(data).video;
        const video = { metadata, url: `/api/video?id=${videoId}` };
        //Render the video for display in the browser.
        res.render('play-video', { video });
      }
      catch {
        logger.error(`${SVC_NAME} ${cid} - Failed to get details for video ${videoId}.`);
      }
    });
    response.on("error",
    err => {
      logger.error(`${SVC_NAME} ${cid} - Failed to get details for video ${videoId}.`);
      logger.error(err || `${SVC_NAME} ${cid} - Status code: ${response.statusCode}`);
      res.sendStatus(500);
    });
  })
  .end();
});

//Web page for uploading a new video.
app.get('/upload',
(req, res) => {
  res.render('upload-video', {});
});

//Web page for showing the users viewing history.
app.get('/history',
(req, res) => {
  const cid = randomUUID();
  logger.info(`${SVC_NAME} ${cid} - Received request for the "Viewing History".`);
  //Get the viewing history from the history microservice.
  http.request({
    host: SVC_DNS_HISTORY,
    path: '/videos',
    method: 'GET',
    headers: {
      'x-correlation-id': cid
    }
  },
  (response) => {
    let data = '';
    response.on('data',
    chunk => {
      data += chunk;
    });
    response.on('end',
    () => {
      //Render the history for display in the browser.
      if (response.statusCode === 500 || data === undefined || data === null || data === '') {
        res.render('history', { videos: JSON.parse('[]') });
      }
      else {
        res.render('history', { videos: JSON.parse(data).videos });
      }
    });
    response.on('error',
    err => {
      logger.error(`${SVC_NAME} ${cid} - Failed to retrieve the viewing history.`);
      logger.error(`${SVC_NAME} ${cid} - ${err}`);
      res.sendStatus(500);
    });
  })
  .end();
});

//HTTP GET API to stream video to the user's browser.
app.get('/api/video',
(req, res) => {
  const cid = randomUUID();
  logger.info(`${SVC_NAME} ${cid} - Received request for "Streaming the Video ${req.query.id}".`);
  //Forward the request to the video streaming microservice.
  const forwardReq = http.request({
    host: SVC_DNS_VIDEO_STREAMING,
    path: `/video?id=${req.query.id}`,
    method: 'GET',
    headers: {
      'x-correlation-id': cid
    }
  },
  forwardRes => {
    res.writeHeader(forwardRes.statusCode, forwardRes.headers);
    forwardRes.pipe(res);
  });
  req.pipe(forwardReq);
});

//HTTP POST API to upload video from the user's browser.
app.post('/api/upload',
(req, res) => {
  const cid = randomUUID();
  /***
  In the HTTP protocol, headers are case-insensitive; however, the Express framework converts
  everything to lower case. Unfortunately, for objects in JavaScript, their property names are
  case-sensitive.
  ***/
  req.headers['x-correlation-id'] = cid;
  logger.info(`${SVC_NAME} ${req.headers['x-correlation-id']} - Received request for the "Upload of the Video ${req.headers['file-name']}".`);
  //Forward the request to the video streaming microservice.
  const forwardReq = http.request({
    host: SVC_DNS_VIDEO_UPLOAD,
    path: '/upload',
    method: 'POST',
    headers: req.headers
  },
  forwardRes => {
    res.writeHeader(forwardRes.statusCode, forwardRes.headers);
    forwardRes.pipe(res);
  });
  req.pipe(forwardReq);
});

/***
The 404 Route
-------------
In Express, 404 responses are not the result of an error, so the error-handler middleware will not
capture them. This behavior is because a 404 response simply indicates the absence of additional
work to do; in other words, Express has executed all middleware functions and routes, and found
that none of them responded. All you need to do is add a middleware function at the VERY BOTTOM of
the stack (below all other functions) to handle a 404 response.
***/
app.use(
(req, res, next) => {
  logger.error(`${SVC_NAME} - Unable to find the requested resource (${req.url})!`);
  res.status(404).send(`<h1>Unable to find the requested resource (${req.url})!</h1>`);
});
