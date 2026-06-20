#######################################
Public api
#######################################

The public api of the library can be found in ``include/licensecc/licensecc.h`` that is the only file you should 
include when you want to use the library. 

Print hardware identifier
**************************

``identify_pc`` returns the hardware identifier that can be used for
machine-bound license issuance. The supported strategy constants are generated
from the project configuration header.


Verify a license
***********************

Functions
=========

.. doxygengroup:: api
   :content-only:

Public data types
=================

.. cpp:type:: uint32_t

.. cpp:type:: uint64_t

.. cpp:var:: const unsigned int LCC_API_ONLINE_PROJECT_SIZE

.. cpp:var:: const unsigned int LCC_API_ONLINE_LICENSE_FINGERPRINT_SIZE

.. doxygenenum:: LCC_EVENT_TYPE

.. doxygenenum:: LCC_LICENSE_DATA_TYPE

.. doxygenenum:: LCC_TAMPER_POLICY

.. doxygenenum:: LCC_ONLINE_POLICY

.. doxygenenum:: LCC_ONLINE_CALLBACK_STATUS

.. doxygenenum:: LCC_LICENSE_DECISION

.. doxygendefine:: LCC_API_PATH_SIZE

.. doxygendefine:: LCC_API_ONLINE_PROJECT_SIZE

.. doxygendefine:: LCC_API_ONLINE_LICENSE_FINGERPRINT_SIZE

.. doxygenstruct:: LccOnlineRequest
   :members:

.. doxygenstruct:: LicenseCheckOptions
   :members:

.. doxygenstruct:: LccLicenseDecisionOptions
   :members:

.. doxygenstruct:: LccLicenseDecision
   :members:

.. doxygenstruct:: LccRevocationFloorRecord
   :members:

.. doxygenstruct:: LccConfigInput
   :members:

.. doxygenstruct:: LccConfigVerifyOptions
   :members:

.. doxygenstruct:: LccConfigDecision
   :members:

.. doxygenstruct:: LccConfigSeqFloorRecord
   :members:

.. doxygenstruct:: CallerInformations
   :members:

.. doxygenstruct:: LicenseLocation
   :members:

.. doxygenstruct:: AuditEvent
   :members:

.. doxygenstruct:: LicenseInfo
   :members:

.. doxygenstruct:: ExecutionEnvironmentInfo
   :members:
