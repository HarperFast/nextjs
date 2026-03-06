`prebuilt: false`
1. First deployment
   - if `.next` folder exists, ignore or error?
     - maybe user accidentally deployed the `.next` dir or they forgot to enable `prebuilt: true`
     - since the two scenarios are indiscernible, we need to log an error and return _without_ doing anything else
       - no building, no serving
       - they need to fix their deployment
   - plugin should proceed to build since no `.next` exists (shouldn't even have to check `build_info` table)
   - first thread: build completes
     - on success
       - the build and `.next/BUILD_ID` now exists on the file system
       - the plugin should write the `BUILD_ID` value to the `build_info` table
     - on failure
       - the `BUILD_ID` should not exist (but maybe some `.next/` artifacts can?)
       - don't write any `BUILD_ID` to the `build_info` table, but maybe write that the build failed (for this deployment) and then other threads can skip trying again?
   - n threads:
     - checks `build_info`
       - if status: success then check build_id and compare with .next/BUILD_ID and either proceed to build or skip, finally serve
       - if status: failure then skip build and serve
2. N deployment
   - What really is a _deployment_? 
     - _Any_ file change within the app directory? 
       - Can definitely skip `.next` dir as thats generated as part of the build so `*` is insufficient
       - Shouldn't ignore `node_modules` since a reasonable change could be _just_ a dependency update
       - in theory they could do a deployment thats like docs or tests only and thus a rebuild isn't necessary
         - but since those can be stored anywhere we can't really provide a narrowed default
         - it must be configurable somehow (using default `files:` option?)
         - if `files:` is undefined then the pattern could be as simple as match everything _except_ `.next`
           - that is obviously overkill, but its whats necessary
           - we could try to improve this default by adding ignore patterns for like `.test.js` files too
           - but I can't really think of anything else to include in the default.
     - There is of course the `deploy` operation
     - But we also have the concept of pull-based deployments too from a previously deployed application
       - harper restarts and will refetch whatever is in the root config
     - I don't think the idea of a "deployment id" is sufficient here. 
     - I think that given a reasonably robust file matching pattern, the plugin should use the `appName` and the `build_info` record and mark it as `stale` or something like that.
   - As changes to the app are made (either by a deployment, or the user manually editing a single file) the entry handler should detect changes and upon seeing a change (not in .next or test files or whatever configured by the user), then it should mark the build_info record as stale and proceed with building and serving.
     - While the initial handleApplication sequential execution across threads enables us to skip a "lock" for the build process, the entry handler executions are not sequential across threads. So as an edit is made, all the threads with an entry handler will start executing simultaneously.
       - We could reinstitute a lock for the build process since reasonably all the threads will need to reserve the new build
       - But we could also try splitting this up into multiple handlers? Maybe only one thread is responsible for a build process, then no lock is needed, but what happens if that thread shuts down? Harper will auto restart it... so if there is a mechanism to verify which thread has the build handler, that could work. But how reliable is that? If that could fail, then someone's server could get in a state where no rebuilds occur on deployments and they have to restart anyways. depending on that reliability it may be more engineering effort than its worth. 
       - Go back to every thread should have a build handler, but use a lock. maybe a lot easier this time using a lock based on the build_info resource?
       - And somehow need to ensure that all threads serve the fresh build
       - So after the build happens on one thread, the record should get updated with a status `success` or `failure`. and all the other threads are looping on that lock. as soon as the lock is released, they should check the build status, and serve if its `success` or just keep what is there if `failure` (don't take down prod just cause of bad build)

https://nextjs.org/docs/13/app/api-reference/next-config-js/generateBuildId


The previous steps were wrong as it has a poor assumption with how deploy actually works. Deploys are not equivalent to file edits. Deploys actually result in `handleApplication` being re-executed. Moreover, the deploy operation starts by running `prepareApplication`, when an application with that name already exists on the system, it overwrites those files entirely. 