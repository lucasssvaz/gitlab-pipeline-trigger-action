const core = require('@actions/core');
const io = require('@actions/io');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * GitLab pipeline status values (see https://docs.gitlab.com/ee/api/pipelines.html#list-project-pipelines):
 * - created: The pipeline has been created but has not yet been processed.
 * - preparing: The pipeline is being prepared to run.
 * - pending: The pipeline is queued and waiting for available resources to start running.
 * - waiting_for_resource: The pipeline is queued, but there are not enough resources available to start running.
 * - running: The pipeline is currently running.
 * - scheduled: The pipeline is scheduled to run at a later time.
 * - failed: The pipeline has completed running, but one or more jobs have failed.
 * - success: The pipeline has completed running, and all jobs have succeeded.
 * - canceled: The pipeline has been canceled by a user or system.
 * - skipped: The pipeline was skipped due to a configuration option or a pipeline rule.
 * - manual: The pipeline is waiting for a user to trigger it manually.
 */
const pollPipeline = async (host, projectId, token, pipelineId, webUrl) => {
    console.log(`Polling pipeline ${pipelineId} on ${host}!`);

    const url = `https://${host}/api/v4/projects/${projectId}/pipelines/${pipelineId}`;
    let status = 'pending';
    const breakStatusList = ['failed', 'success', 'canceled', 'skipped'];

    while (true) {
        // wait 15 seconds
        await wait(15000);

        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'PRIVATE-TOKEN': token,
                    'Accept': 'application/json',
                },
            });

            if (!response.ok) {
                let errorMessage = `GitLab API returned status code ${response.status}.`;
                if (response.status === 401) {
                    errorMessage = "Unauthorized: invalid/expired access token was used.";
                }
                core.setFailed(errorMessage);
                break;
            }

            const data = await response.json();

            status = data.status;
            core.setOutput("status", status);
            console.log(`Pipeline status: ${status} (${webUrl})`);

            if (status === 'failed') {
                core.setFailed(`Pipeline failed!`);
            }

            if (breakStatusList.includes(status)) {
                console.log(`Status "${status}" detected, breaking loop!`);
                break;
            }
        } catch (error) {
            core.setFailed(error.message);
            break;
        }
    }

    return status;
}

/**
 * Downloads job logs from a GitLab pipeline job
 * @param {string} host - GitLab host
 * @param {string} projectId - Project ID
 * @param {string} token - Access token
 * @param {string} jobId - Job ID
 * @param {string} jobName - Job name
 * @param {string} jobLogsPath - Path to save job logs
 * @returns {Promise<boolean>} - Whether job logs were downloaded successfully
 */
const downloadJobLogs = async (host, projectId, token, jobId, jobName, jobLogsPath) => {
    try {
        console.log(`Downloading logs for job: ${jobName} (${jobId})`);

        const logUrl = `https://${host}/api/v4/projects/${projectId}/jobs/${jobId}/trace`;
        const logResponse = await fetch(logUrl, {
            method: 'GET',
            headers: {
                'PRIVATE-TOKEN': token,
                'Accept': 'text/plain',
            },
        });

        if (!logResponse.ok) {
            console.log(`Failed to download logs for job ${jobId}: ${logResponse.status}`);
            return false;
        }

        const logContent = await logResponse.text();
        const logFilePath = path.join(jobLogsPath, 'job.log');

        fs.writeFileSync(logFilePath, logContent);
        console.log(`Successfully downloaded logs for job: ${jobId}`);
        return true;

    } catch (error) {
        console.log(`Error downloading logs for job ${jobId}: ${error.message}`);
        return false;
    }
};

/**
 * Downloads job logs from all jobs in a pipeline
 * @param {string} host - GitLab host
 * @param {string} projectId - Project ID
 * @param {string} token - Access token
 * @param {string} pipelineId - Pipeline ID
 * @param {string} downloadPath - Path to save job logs
 * @param {Array} jobs - Array of pipeline jobs (pre-fetched)
 * @returns {Promise<boolean>} - Whether job logs were downloaded successfully
 */
const downloadAllJobLogs = async (host, projectId, token, pipelineId, downloadPath, jobs) => {
    try {
        console.log(`Downloading job logs for pipeline ${pipelineId}...`);

        // Create download directory
        await io.mkdirP(downloadPath);

        let logsDownloadedCount = 0;

        // Download logs from all jobs
        for (const job of jobs) {
            try {
                const jobLogsPath = path.join(downloadPath, `job_${job.id}_${job.name.replace(/[^a-zA-Z0-9]/g, '_')}`);

                // Create job-specific directory
                await io.mkdirP(jobLogsPath);

                const logDownloaded = await downloadJobLogs(host, projectId, token, job.id, job.name, jobLogsPath);
                if (logDownloaded) {
                    logsDownloadedCount++;
                }
            } catch (error) {
                console.log(`Error processing logs for job ${job.name}: ${error.message}`);
            }
        }

        if (logsDownloadedCount > 0) {
            console.log(`Successfully downloaded logs from ${logsDownloadedCount} jobs to ${downloadPath}`);
            return true;
        } else {
            console.log('No job logs were successfully downloaded');
            return false;
        }

    } catch (error) {
        console.log(`Error downloading job logs: ${error.message}`);
        return false;
    }
};

/**
 * Downloads artifacts from a GitLab pipeline job
 * @param {string} host - GitLab host
 * @param {string} projectId - Project ID
 * @param {string} token - Access token
 * @param {string} pipelineId - Pipeline ID
 * @param {string} downloadPath - Path to save artifacts and logs
 * @param {boolean} downloadJobLogsFlag - Whether to download job logs
 * @param {Array} jobs - Array of pipeline jobs (pre-fetched)
 * @returns {Promise<boolean>} - Whether artifacts were downloaded successfully
 */
const downloadArtifacts = async (host, projectId, token, pipelineId, downloadPath, downloadJobLogsFlag, jobs) => {
    try {
        console.log(`Downloading artifacts for pipeline ${pipelineId}...`);

        const jobsWithArtifacts = jobs.filter(job => job.artifacts_file && job.artifacts_file.filename);

        if (jobsWithArtifacts.length === 0 && !downloadJobLogsFlag) {
            console.log('No jobs with artifacts found and job logs not requested');
            return false;
        }

        // Create download directory
        await io.mkdirP(downloadPath);

        let downloadedCount = 0;
        let logsDownloadedCount = 0;

        // Download artifacts from jobs that have them
        for (const job of jobsWithArtifacts) {
            try {
                console.log(`Downloading artifacts from job: ${job.name} (${job.id})`);

                const artifactUrl = `https://${host}/api/v4/projects/${projectId}/jobs/${job.id}/artifacts`;
                const artifactResponse = await fetch(artifactUrl, {
                    method: 'GET',
                    headers: {
                        'PRIVATE-TOKEN': token,
                        'Accept': 'application/octet-stream',
                    },
                });

                if (!artifactResponse.ok) {
                    console.log(`Failed to download artifacts for job ${job.name}: ${artifactResponse.status}`);
                    continue;
                }

                const artifactBuffer = await artifactResponse.arrayBuffer();
                const jobArtifactsPath = path.join(downloadPath, `job_${job.id}_${job.name.replace(/[^a-zA-Z0-9]/g, '_')}`);

                // Create job-specific directory
                await io.mkdirP(jobArtifactsPath);

                // Save the zip file
                const zipPath = path.join(jobArtifactsPath, 'artifacts.zip');
                fs.writeFileSync(zipPath, Buffer.from(artifactBuffer));

                // Extract the zip file
                const zip = new AdmZip(zipPath);
                zip.extractAllTo(jobArtifactsPath, true);

                // Remove the zip file after extraction
                fs.unlinkSync(zipPath);

                console.log(`Successfully downloaded artifacts for job: ${job.name}`);
                downloadedCount++;

            } catch (error) {
                console.log(`Error downloading artifacts for job ${job.name}: ${error.message}`);
            }
        }

        // Download job logs if requested
        if (downloadJobLogsFlag) {
            console.log('Downloading job logs...');
            for (const job of jobs) {
                try {
                    const jobLogsPath = path.join(downloadPath, `job_${job.id}_${job.name.replace(/[^a-zA-Z0-9]/g, '_')}`);

                    // Create job directory if it doesn't exist (for jobs without artifacts)
                    if (!jobsWithArtifacts.find(j => j.id === job.id)) {
                        await io.mkdirP(jobLogsPath);
                    }

                    const logDownloaded = await downloadJobLogs(host, projectId, token, job.id, job.name, jobLogsPath);
                    if (logDownloaded) {
                        logsDownloadedCount++;
                    }
                } catch (error) {
                    console.log(`Error processing logs for job ${job.name}: ${error.message}`);
                }
            }
        }

        if (downloadedCount > 0 || logsDownloadedCount > 0) {
            const summary = [];
            if (downloadedCount > 0) {
                summary.push(`artifacts from ${downloadedCount} jobs`);
            }
            if (logsDownloadedCount > 0) {
                summary.push(`logs from ${logsDownloadedCount} jobs`);
            }
            console.log(`Successfully downloaded ${summary.join(' and ')} to ${downloadPath}`);
            return true;
        } else {
            console.log('No artifacts or logs were successfully downloaded');
            return false;
        }

    } catch (error) {
        console.log(`Error downloading artifacts: ${error.message}`);
        return false;
    }
};

async function run() {
    const host = encodeURIComponent(core.getInput('host'));
    const projectId = encodeURIComponent(core.getInput('id'));
    const triggerToken = core.getInput('trigger_token');
    const accessToken = core.getInput('access_token');
    const ref = core.getInput('ref');
    const variables = JSON.parse(core.getInput('variables'));
    const downloadArtifactsFlag = core.getInput('download_artifacts') === 'true';
    const downloadArtifactsOnFailure = core.getInput('download_artifacts_on_failure') === 'true';
    const downloadJobLogsFlag = core.getInput('download_job_logs') === 'true';
    const failIfNoArtifacts = core.getInput('fail_if_no_artifacts') === 'true';
    const downloadPath = core.getInput('download_path');

    console.log(`Triggering pipeline ${projectId} with ref ${ref} on ${host}!`);

    if (downloadArtifactsFlag && !accessToken) {
        core.setFailed('download_artifacts is enabled but access_token is not provided. Access token is required to download artifacts.');
        return;
    }

    if (downloadJobLogsFlag && !accessToken) {
        core.setFailed('download_job_logs is enabled but access_token is not provided. Access token is required to download job logs.');
        return;
    }

    try {
        const url = `https://${host}/api/v4/projects/${projectId}/trigger/pipeline`;

        // https://docs.gitlab.com/ee/api/pipeline_triggers.html#trigger-a-pipeline-with-a-token
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                token: triggerToken,
                ref: ref,
                variables: variables,
            }),
        });

        if (!response.ok) {
            let errorMessage = `GitLab API returned status code ${response.status}.`;
            if (response.status === 404) {
                errorMessage = "The specified resource does not exist, or an invalid/expired trigger token was used.";
            }
            return core.setFailed(errorMessage);
        }

        const data = await response.json();

        core.setOutput("id", data.id);
        core.setOutput("status", data.status);
        core.setOutput("web_url", data.web_url);
        console.log(`Pipeline id ${data.id} triggered! See ${data.web_url} for details.`);

        // poll pipeline status
        const finalStatus = await pollPipeline(host, projectId, accessToken, data.id, data.web_url);

        // Fetch jobs once if either artifacts or logs need to be downloaded
        let jobs = null;
        if (downloadArtifactsFlag || downloadJobLogsFlag) {
            console.log('Fetching pipeline jobs...');
            const jobsUrl = `https://${host}/api/v4/projects/${projectId}/pipelines/${data.id}/jobs`;
            const jobsResponse = await fetch(jobsUrl, {
                method: 'GET',
                headers: {
                    'PRIVATE-TOKEN': accessToken,
                    'Accept': 'application/json',
                },
            });

            if (!jobsResponse.ok) {
                console.log(`Failed to fetch jobs: ${jobsResponse.status}`);
                jobs = [];
            } else {
                jobs = await jobsResponse.json();
                console.log(`Found ${jobs.length} jobs in pipeline`);
            }
        }

        // Download artifacts if enabled
        if (downloadArtifactsFlag && jobs) {
            let shouldDownload = false;
            let downloadReason = '';

            if (finalStatus === 'success') {
                shouldDownload = true;
                downloadReason = 'Pipeline succeeded';
            } else if (downloadArtifactsOnFailure && finalStatus === 'failed') {
                shouldDownload = true;
                downloadReason = 'Pipeline failed but artifacts download on failure is enabled';
            }

            if (shouldDownload) {
                console.log(`${downloadReason}, downloading artifacts...`);
                const artifactsDownloaded = await downloadArtifacts(host, projectId, accessToken, data.id, downloadPath, downloadJobLogsFlag, jobs);
                core.setOutput("artifacts_downloaded", artifactsDownloaded.toString());

                if (artifactsDownloaded) {
                    console.log(`Artifacts and logs downloaded successfully to ${downloadPath}`);
                } else {
                    console.log('No artifacts or logs were downloaded');

                    // Fail the action if no artifacts found and fail_if_no_artifacts is enabled
                    if (failIfNoArtifacts) {
                        core.setFailed('No artifacts were found and fail_if_no_artifacts is enabled. This may indicate a configuration issue or that the pipeline did not generate expected artifacts.');
                        return;
                    }
                }
            } else {
                console.log(`Pipeline status is ${finalStatus}, skipping artifact download`);
                core.setOutput("artifacts_downloaded", "false");
            }
        }

        // Download job logs independently if enabled
        if (downloadJobLogsFlag && jobs) {
            console.log('Downloading job logs...');
            const logsDownloaded = await downloadAllJobLogs(host, projectId, accessToken, data.id, downloadPath, jobs);

            if (logsDownloaded) {
                console.log(`Job logs downloaded successfully to ${downloadPath}`);
            } else {
                console.log('No job logs were downloaded');
            }
        }
    } catch (error) {
        core.setFailed(error.message);
    }
}

run()
