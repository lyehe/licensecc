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

A ``project`` in `licensecc` terms refers to a folder containing a private key, a public key and a file containing customizations. 
Licensecc configures one project into each build. Project material is generated
outside the source checkout (or under the active build directory); the source
tree does not carry a pre-generated ``projects`` directory. A development build
can generate a ``DEFAULT`` project for its selected build tree.

::
    
	<generated project base>
	└── DEFAULT       #(your project name)
	    ├── include
	    │   └── licensecc
	    │       └── DEFAULT
	    │           ├── licensecc_properties.h
	    │           └── public_key.h
	    ├── licenses
	    │   └── test.lic
	    └── private_key.rsa

If you want to use or create a new project in the configure phase of CMake,
specify ``-DLCC_PROJECT_NAME`` and, when needed, an external
``-DLCC_PROJECTS_BASE_DIR``. See :doc:`../development/Build-the-library` for
the source-tree purity constraint.

A `licensecc-project` corresponds to one executable it has to be licensed. So for instance suppose you have two executables "Foo" and "Bar"
and you want to issue licenses separately (licenses of "Foo" incompatible with "Bar") you need to: 

* create two `licensecc-projects` eg. "FooLicensecc" and "BarLicensecc" (names are for example here, you can choose them as you like, remember they will appear in the license file). 
* for each project: 
  	* configure, compile and install `licensecc`

In "Foo" and "Bar" (your original software) be sure to locate and link the right version of `licensecc-static-lib`. Eg. in your "Foo" CmakeLists.txt:

Point ``CMAKE_PREFIX_PATH`` at the install prefix of the matching licensecc build
and add the following line to your ``CMakeLists.txt`` (see
:ref:`usage/integration:Integrate Licensecc in your application`):

.. code-block::

  find_package(licensecc REQUIRED COMPONENTS "FooLicensecc")


Features
================

A licensed software can have multiple functions that can be enabled or disabled independently using license files.
Each software function takes the name of `feature` in Licensecc. 
Each feature can (need to) be licensed separately, the licenses then are merged in one license file and sent to the customer.
 
There are parameters in ``lccgen`` to produce a multi-feature license directly avoiding the manual merge:

.. code-block:: 

	lccgen license issue -f PROJECT_NAME,MY_AWESOME_FEATURE -o example.lic
	
To verify a feature pass the feature name in the ``CallerInformations`` structure 
(see: :ref:`verify license <api/public_api:Verify a license>`):

.. code-block:: c

	CallerInformations callerInfo = {"\0", "MY_AWESOME_FEATURE"};
	LCC_EVENT_TYPE result = acquire_license(&callerInfo, nullptr, &licenseInfo);
	
For a complete fail-closed feature example, see
`examples/fail_closed_host <https://github.com/lyehe/licensecc/tree/main/examples/fail_closed_host>`_.

Versions
================

Caller-version input and license version limits are implemented in the C++
runtime. See the :doc:`capability registry <../capabilities/index>` for the
current evidence and limitations.
