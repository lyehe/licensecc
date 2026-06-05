###########################################
Projects, features and versions
###########################################

Projects
================

Licensecc is a library to protect your software from unauthorized copies. It does so generating a private key
to sign the licenses and a public key to verify the signatures. The public key is included in binary form in the 
compiled `licensecc-static-lib` library at compile time. 

Since we're open source the keys can't be generated once and committed to github, we need to generate them before the 
compilation of the library. 

A ``project`` in `licensecc` terms refers to a folder containing a private key,
a public key and generated customizations. A Licensecc build embeds one project
at a time.

Clean builds store generated projects under the build tree by default. For
release builds, configure a non-default ``LCC_PROJECT_NAME`` and an
issuer-controlled ``LCC_PROJECTS_BASE_DIR`` outside the source tree. The
``DEFAULT`` project is suitable for local tests only; source-tree key
generation requires the explicit development opt-in
``-DLCC_ALLOW_SOURCE_TREE_KEYGEN=ON``.

Below is the project structure for a release project named ``MY_PRODUCT``:

::
    
	/secure/licensecc-projects
	└── MY_PRODUCT
	    ├── include
	    │   └── licensecc
	    │       └── MY_PRODUCT
	    │           ├── licensecc_properties.h
	    │           └── public_key.h
	    ├── licenses
	    │   └── test.lic
	    └── private_key.rsa

Create or select that project during CMake configure:

.. code-block:: console

  cmake -S licensecc -B build-licensecc \
    -DLCC_PROJECT_NAME=MY_PRODUCT \
    -DLCC_PROJECTS_BASE_DIR=/secure/licensecc-projects

A `licensecc-project` corresponds to one executable it has to be licensed. So for instance suppose you have two executables "Foo" and "Bar"
and you want to issue licenses separately (licenses of "Foo" incompatible with "Bar") you need to: 

* create two `licensecc-projects` eg. "FooLicensecc" and "BarLicensecc" (names are for example here, you can choose them as you like, remember they will appear in the license file). 
* for each project: 
  	* configure, compile and install `licensecc`

In "Foo" and "Bar" (your original software) be sure to locate and link the right installed Licensecc package.
For example, in your "Foo" ``CMakeLists.txt``:
 
.. code-block:: cmake

  find_package(licensecc 2.1.0 REQUIRED COMPONENTS FooLicensecc)
  target_link_libraries(foo PRIVATE licensecc::licensecc_static)


Features
================

A licensed software can have multiple functions that can be enabled or disabled independently using license files.
Each software function takes the name of `feature` in Licensecc. 
Each feature can (need to) be licensed separately, the licenses then are merged in one license file and sent to the customer.
 
There are parameters in ``lccgen`` to produce a multi-feature license directly avoiding the manual merge:

.. code-block:: 

	lccgen license issue -f PROJECT_NAME,REPORTS -o example.lic
	
To verify a feature pass the feature name in the ``CallerInformations`` structure 
(see: :ref:`verify license <api/public_api:Verify a license>`):

.. code-block:: c

	CallerInformations callerInfo = {};
	callerInfo.magic = LCC_PROJECT_MAGIC_NUM;
	strncpy(callerInfo.feature_name, "REPORTS", sizeof(callerInfo.feature_name) - 1);
	callerInfo.feature_name[sizeof(callerInfo.feature_name) - 1] = '\0';
	LCC_EVENT_TYPE result = acquire_license(&callerInfo, nullptr, &licenseInfo);
	if (result == LICENSE_OK) {
		enable_reports();
	}
	
For a working example see `program_features <https://github.com/open-license-manager/examples/program_features>`_ in 
examples project.

Versions
================

License files can limit which software versions are licensed by using
``start-version`` and ``end-version``. These bounds are inclusive.

When either bound is present, the licensed application must pass
``CallerInformations.version`` to ``acquire_license``. Supported version values
contain one to three numeric components separated by dots, for example ``1``,
``1.2`` or ``1.2.3``. Each component may contain up to four digits.

If the caller version is missing, malformed, or outside the licensed range,
``acquire_license`` returns ``PRODUCT_NOT_LICENSED``. If the license contains a
malformed version bound, verification fails closed with ``LICENSE_MALFORMED``.

License file format versions
============================

Current runtimes accept the strict legacy ``lic_ver = 200`` format and the
canonical ``lic_ver = 201`` format. The generator still defaults to
``--license-version=200`` so issuance scripts remain compatible with older
deployed runtimes.

Issue v201 only after confirming the target runtime can verify it:
``lccgen license issue --license-version=201 --target-license-format-max=201``.
The target-format option is an explicit compatibility signal; without it,
``lccgen`` refuses v201 issuance. Older v200-only runtimes reject v201 license
files as malformed or unsupported.
